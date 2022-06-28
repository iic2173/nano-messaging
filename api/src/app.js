// const env = require('dotenv').config();
const path = require('path');
const Koa = require('koa');
const cors = require('koa2-cors');
const koaBody = require('koa-body');
const koaLogger = require('koa-logger');
const koajwt = require('koa-jwt');
const override = require('koa-override-method');
const helmet = require('koa-helmet');
const http = require('http');
// const casbin = require('casbin')
// const authz = require('koa-authz');

// Things for websockets
const redis = require('redis');
const KoaRouter = require('koa-router');

const wsrouter = new KoaRouter();
const jwt = require('jsonwebtoken');

// App constructor
const websockify = require('koa-websocket');
const orm = require('./models');

const app = websockify(new Koa());

var options = {
  origin: '*'
};
app.use(cors(options));

const developmentMode = app.env === 'development';
const testMode = app.env === 'test';
const productionMode = app.env === 'production';

if (testMode || productionMode) {
  // Helmet stuff -> Some security initiatives
  // app.use(helmet.frameguard('sameorigin'));
  app.use(helmet.hidePoweredBy());
  app.use(helmet.noSniff());
  /* app.use(
    helmet.hsts({
      force: true,
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    }),
  ); */
  app.use(helmet.ieNoOpen());
  app.use(helmet.xssFilter());
} else if (developmentMode) {
  const a = 0;
} else {
  process.exit(1);
}

// expose ORM through context's prototype
app.context.orm = orm;

/**
 * Middlewares
 */

// expose running mode in ctx.state

app.use((ctx, next) => {
  ctx.response.meta = {};
  ctx.response.json = {};
  ctx.state.env = ctx.app.env;
  ctx.acceptsEncodings('gzip', 'deflate', 'br');
  return next();
});
// log requests
app.use(koaLogger());

app.use(koajwt({
  secret: process.env.JWT_MASTER_SECRET,
  key: 'tokendata',
  // passthrough: true,
  //audience: process.env.AUDIENCE,
  //issuer: process.env.ISSUER,
}));

// parse request body
app.use(koaBody({
  multipart: true,
  keepExtensions: true,
  formidable: {
    maxFields: 10,
    maxFieldsSize: 30 * 1024 * 1024,
    maxFileSize: 100 * 1024 * 1024,
    uploadDir: path.join(__dirname, '..', 'uploads'),
    keepExtensions: true,
    multiples: true,
  },
}));

app.use((ctx, next) => {
  ctx.request.method = override.call(ctx, ctx.request.body.fields || ctx.request.body);
  return next();
});

const messageWrapper = async (ctx, next) => {
  await next();
  let { status } = ctx;
  ctx.response.body = {};
  if (ctx.response.meta === undefined) {
    ctx.response.meta = {};
  }
  if (Object.keys(ctx.response.json).length > 0 && status == 404) {
    status = 200;
  }
  ctx.response.body.meta = ctx.response.meta;
  ctx.response.body.meta.code = status;
  ctx.response.body.meta.message = http.STATUS_CODES[status];
  ctx.response.body.content = ctx.response.json;
  ctx.response.status = status;
};

app.use(messageWrapper);

app.use(async (ctx, next) => {
  try {
    await next();
    if (ctx.status === 404) {
      ctx.throw(404);
    } else if (ctx.status === 500) {
      ctx.throw(500);
    }
  } catch (error) {
    let message = '';
    ctx.status = error.status || 500;
    await ctx.app.emit('error', error, ctx);
    if (ctx.status === undefined) {
      message = 'Internal Server Error';
    } else {
      message = http.STATUS_CODES[ctx.status];
    }
    ctx.response.meta.message = message;
    // await message_wrapper(ctx, ()=>{});
  }
});

// On websockets
// FFS this don't accept require

// https://github.com/kudos/koa-websocket/pull/18

const REDIS_SERVER = 'redis://pubsub:6379';

const redisClientCommonPub = redis.createClient(REDIS_SERVER);

app.ws.use((ctx, next) => {
  ctx.redisClientCommonPub = redisClientCommonPub;
  ctx.orm = orm;
  return next();
});

async function authorizeMessageToRoom(ctx, message, actualUser) {
  let authorized = false;
  const roomPermissions = await ctx.orm.Room_permission.findAll({
    where: {
      room_id: message.room_id,
      entity_UUID: actualUser.userUUID,
    },
  });
  if (roomPermissions) {
    roomPermissions.forEach((element) => {
      if (!authorized && element.permissions.indexOf('w') > -1 && element.level >= actualUser.levelOnEntity) {
        authorized = true;
      }
    });
  }
  if (authorized) {
    return message.room_id;
  }
  return 0;
}
wsrouter.all('/chat', async (ctx) => {
  const redisClientSub = redis.createClient(REDIS_SERVER);
  let actualUser;
  let authReady = false;
  let roomIDTarget = 0;
  let trials = 0;
  ctx.websocket.send('{"type":"query","data":"START?"}');
  ctx.websocket.on('message', async (message) => {
    let command = '';
    try {
      command = JSON.parse(message);
    } catch {
      // Drops for bad bodies
      ctx.websocket.send('{"type":"status","data":"BADJSON"}');
      ctx.websocket.close();
    }
    if (!authReady) {
      if (command.type === 'token') {
        try {
          actualUser = jwt.verify(command.content, process.env.JWT_MASTER_SECRET);
          authReady = true;
          ctx.websocket.send('{"type":"status","data":"READY"}');
        } catch {
          // Drops for bad authentications
          ctx.websocket.send('{"type":"status","data":"BADAUTH"}');
          trials += 1;
          if (trials > 2) {
            ctx.websocket.close();
          }
        }
      } else {
        ctx.websocket.send('{"type":"query","data":"TOKEN?"}');
        trials += 1;
        if (trials > 2) {
          ctx.websocket.close();
        }
      }
    } else if (command.type === 'select_room') {
      roomIDTarget = await authorizeMessageToRoom(ctx, command, actualUser);
      if (roomIDTarget === 0) {
        ctx.websocket.send('{"type":"status","data":"NOTAUTHORIZED"');
      } else {
        ctx.websocket.send('{"type":"status","data":"CONNECTED"}');
        redisClientSub.unsubscribe('*'); // Test this
        redisClientSub.subscribe(`room-${roomIDTarget}`);
      }
    } else if (command.type === 'get_past_messages') {
      if (roomIDTarget > 0) {
        let messages = await ctx.orm.Message.findAll({
          where: {
            room_id: roomIDTarget,
          },
          order: [['createdAt', 'ASC']],
        });
        messages.forEach((message) => {
          const response = {
            type: 'message',
            data: message,
          };
          ctx.websocket.send(JSON.stringify(response));
        });
      } else {
        ctx.websocket.send('{"type":"query","data":"SELECTROOM?"}');
      }
    } else if (command.type === 'message') {
      if (roomIDTarget > 0) {
        const msg = {
          room_id: roomIDTarget,
          content: command.content,
          emitter: actualUser.userUUID,
        };
        await ctx.orm.Message.create(msg);
        delete msg.room_id;
        ctx.redisClientCommonPub.publish(`room-${roomIDTarget}`, JSON.stringify(msg));
      } else {
        ctx.websocket.send('{"type":"query","data":"SELECTROOM?"}');
      }
    } else if (command.type === 'quit') {
      ctx.websocket.close();
    } else {
      ctx.websocket.send('{"type":"query","data":"COMMAND?"}');
    }
  });
  ctx.websocket.on('close', (message) => {
    redisClientSub.quit();
  });
  ctx.websocket.on('error', (message) => {
    redisClientSub.quit();
  });
  redisClientSub.on('message', (channel, message) => {
    const response = {
      type: 'message',
      data: JSON.parse(message),
    };
    ctx.websocket.send(JSON.stringify(response));
  });
});

app.ws.use(wsrouter.routes()).use(wsrouter.allowedMethods());

const baseRouter = require('./routes');

app.use(baseRouter.middleware());
module.exports = app;
