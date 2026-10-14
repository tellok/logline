Logline
=======

English | [简体中文](./README.zh-CN.md)

> This README describes stable v1. Experimental v2 is developed independently on the [v2 branch](https://github.com/tellok/logline/tree/v2), with a [separate README](https://github.com/tellok/logline/blob/v2/README.md). Default npm/pnpm installs continue to use v1 under `latest`. Once published, v2 is available explicitly as `logline@next`.

Logline is a light-weighted, useful log agent for front-end on the client-side.

Why position problems is difficult for the front-end?
---------------------------------------------------

Most front-enders should have similar experience, when codes are deployed for production, running on countless clients. In most caes, we can only guess the problems, especially some occasional visible problems, because we have no idea what's our user's acctual operations, thus it's hard for us to reproduce the scenes. At this moment, we think, it will be great help if we have a detailed and classified log agent, just like the backend do.

Application scenario
-------------------

- Reproduce user operations

    In the production environment, user's operations are un-predicable, even they
    cannot remember the details themselves, with log, we have the ability to
    reproduce the operation paths and running state.

- Monitoring core processes

    In the core processes in our products, we can upload the logs positively,
    as we can focus our user's problems and count the amount quickly.

- Positively get user's logs and analysis user's activities

    Don't believe on the users to coordinate you, we can design a strategy, such as
    deploy an json file online, configure a list containing the target users we
    wanted, when our product is opened on their client, they will download this
    json file after a certain delay(to prevent affections on the core process's
    performance), if the user id is in the list, we will upload the logs positively.

- Count errors and help to analysis

    We can make use of Logline to count js errors. With the error stack, we can speed
    up the analysis.

Features
-------

- No extra dependencies
- client-side(reach when acctually needed, save bandwith and traffic)
- multiple filter dimension(namespace, degree and keyword)
- multiple stores(IndexDB, Websql, localStorage)
- cleanable(in case take too much user space)

Quick to get started
-------------------

### 1. Installation

#### with Bower

```shell
bower install logline
```

#### Download archive

access [https://github.com/tellok/logline/releases](https://github.com/tellok/logline/releases), selecte the version you wanted.

### 2. Import to your project

Logline is an UMD ready module, choose to import it as your project needed.
CMD is evil, which is not supported, wrapper it yourself if you need it indeed.

```javascript
// using <script> element
<script src="./mod/logline.min.js"></script>;

// using AMD loader
var Logline = require('./mod/logline.min');
```

### 3. Choose a log protocol

Logline implements three protocols, all of them are mounted on the `Logline` object for special uses, together with better semantics.

- `websql:` Logline.PROTOCOL.WEBSQL
- `indexeddb:` Logline.PROTOCOL.INDEXEDDB
- `localstorage:` Logline.PROTOCOL.LOCALSTORAGE

you can use `using` method to specialfy a protocol.

```javascript
Logline.using(Logline.PROTOCOL.WEBSQL);
```

_**If you call Logline related APIs, without specialfy a protocol in advance**_, Logline will choose a available protocol automatically, respect the priority according to the configuration parameters during the compile process.

such as, your compile command is `npm run configure -- --with-indexeddb --with-websql --with-localstorage`,
if protocol indexeddb is available, then indexeddb protocol with be chosen automatically,
otherwise, if indexeddb protocol is not available and websql protocol is available, then websql protocol will be chosen, and so on.

If none of the compiled protocols are available, an error will be thrown.

#### 4. Record logs

```javascript
var spaLog = new Logline('spa'),
    sdkLog = new Logline('sdk');

// with description, without extra data
spaLog.info('init.succeed');

// with description and extra data
spaLog.error('init.failed', {
    retcode: 'EINIT',
    retmsg: 'invalid signature',
});

// with description, without extra data
sdkLog.warning('outdated');

// with description and extra data
sdkLog.critical('system.vanish', {
    // debug infos here
});
```

### 5. Read logs

```javascript
// collect all logs
Logline.all(function (logs) {
    // process logs here
});

// collet logs within .3 days
Logline.get('.3d', function (logs) {
    // process logs here
});

// collect logs from 3 days before, and earlier than 1 days ago
Logline.get('3d', '1d', function (logs) {
    // process logs here
});
```

### 6. Clean logs

```javascript
Logline.keep(0.5); // keep logs within half a day, if `.5` is not provided, will clean up all logs
Logline.clean(); // clean all logs and delete database
```

Custom database name
-------------------

Because indexeddb, websql and localstorage are all domain shared storage, the default database name `logline` may have already been taken, you can specialfy a custom database name in two ways as follows:

```javascript
// special a second parameter when calling `using` API
Logline.using(Logline.PROTOCOL.WEBSQL, 'newlogline');

// call `database` API
Logline.database('newlogline');
```

Custom Compile
--------------

Logline implements `localstorage`, `websql` and `indexeddb` protocols, all of them are compiled by default, if you don't need all of them, you can use `npm run configure` and `npm run build` to compile your custom build with partial protocols packed. This helps to reduces the package size.

```shell
// pack all protocols with no parameters
npm run configure
// pack only wanted protocols, remove corresponding --with-xx
npm run configure -- --with-localstorage --with-websql

// re-compile
npm run build
// find the custom build in dist fold
ls -l dist/
```

FAQ
---

### How to upload logs

since v1.0.1, log upload ability is removed, as the upload procedures varies upon different projects,
and we do hope Logline to focus on log recording and maintenance.
Anyway, you can still use `Logline.all` and `Logline.get` to get the logs,
and implement your own upload procedure.

[travis-image]: https://api.travis-ci.org/latel/logline.svg
[travis-url]: https://travis-ci.org/latel/logline
