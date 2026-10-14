Logline
=======

~本项目的实现和结构已经过时，不建议使用~

[English](./README.md) | 简体中文

> 本文介绍稳定版 v1。实验版 v2 位于独立的 [v2 分支](https://github.com/tellok/logline/tree/v2)，参见 [v2 文档](https://github.com/tellok/logline/blob/v2/README.zh-CN.md)。默认 npm/pnpm 安装仍使用 `latest` 上的 v1；v2 首次预发布后需显式安装 `logline@next`。

logline是一个轻量，实用和客户端级的前端日志记录工具。

为何前端定位问题很困难
-----------------

前端同学对此肯定深有体会，代码发出去之后，犹如脱缰的野马，运行在万千的客户终端上，等到产品和后台反馈问题到我们这边，很多时候定位问题只能靠猜，尤其是一些偶发诱因，因为根本不知道用户是如何操作的，真实环境遇到的问题通常是很多随机因素叠加的形成的，因此很难回放用户的操作来还原现场找到原因。这个时候，我们想，如果有一个像后台一样详实的可分类和检索的运行日志，无疑将会提供巨大的帮助。

应用场景
------

- 回放用户细节操作

    真实应用场景下，用户的行为可能是不可预料的，甚至用户自己也无法记得自己的操作，有了日志，我们有了回放用户操作和代码运行状态的能力。

- 核心流程监控

    在产品的一些核心流程中，我们可以在用户出错的情况下主动上传用户日志，以便我们可以快速统计和定位用户遇到的问题。

- 主动抓取用户的日志分析用户行为

    有时候在用户不配合开发人员的时候，我们可以设计一种策略，比如我们在线上发布一个json文件，里面配置一个希望主动抓取日志的用户列表，当我们的产品在用户手机上被打开后，延时下载（避免影响主流程性能）这个json，当匹配当前用户时，直接主动上报该用户的日志。

- 统计和辅助分析JS错误

    我们可以记录js的报错，包含调用队列一起记录，直接上传此错误日志或者在累计达到一个阈值的时候统一上传。

特性
---

- 零外部依赖
- 客户端存放（需要时再获取，节省移动带宽、流量和连接数）
- 多维度过滤（命名空间、日志等级和关键词）
- 多个存储方案（Websql、localStorage和IndexedDB）
- 可清理（防止日志过多，占用上传带宽和占满用户允许的内存）

快速上手
------

### 1. 安装

#### 通过npm

```shell
npm install logline
```

#### 直接下载

访问 [https://github.com/tellok/logline/releases](https://github.com/tellok/logline/releases)，选择需要的版本下载，引入自己的项目。

### 2. 引入脚本

Logline 支持直接使用 script 标签引用，也支持 AMD 模块加载器。

```javascript
// Script标签引入方式
<script src="./mod/logline.min.js"></script>;
// AMD模块方式（如requirejs）
var Logline = require('./mod/logline.min');
// CMD引入方式（使用npm安装）
var Logline = require('logline');
// ES6引入方式（使用npm安装）
import Logline from 'logline';
```

### 3. 选择日志协议

目前一共支持三个协议， 三个协议都被直接挂载在Logline对象上以便一些特殊的应用场景，也更好的符合语义化:

- websql: Logline.PROTOCOL.WEBSQL
- indexeddb: Logline.PROTOCOL.INDEXEDDB
- localstorage: Logline.PROTOCOL.LOCALSTORAGE

你可以在引入Logline之后，使用 `using` 主动选定一个期望使用的日志协议。

```javascript
Logline.using(Logline.PROTOCOL.WEBSQL);
```

_**如果你没有提前选择一个日志协议，那么当你调用Logline的相关 API 时**_，Logline 会根据你在构建时给定的参数作为优先级来选择可用的优先级最高的协议。
比如你的自定义构建命令是`npm run configure -- --with-indexeddb --with-websql --with-localstorage`，
如果 indexeddb 协议可用，那么indexeddb将作为自动选择的协议。
如果 indexeddb 协议不可用但是 websql 协议可用，那么将选择 websql 协议，如此类推。

如果最后发现所有的协议都不可用，将会抛出错误。

### 4. 记录日志

```javascript
// 不同的模块使用不同的日志会话
var spaLog = new Logline('spa'),
    sdkLog = new Logline('sdk');

// 不包含数据的，描述为 init.succeed 的记录
spaLog.info('init.succeed');

// 包含错误描述数据，描述为 init.failed 的记录
spaLog.error('init.failed', {
    retcode: 'EINIT',
    retmsg: 'invalid signature',
});

// 不包含数据的，描述为 outdated 的记录
sdkLog.warn('outdated');

// 包含错误描述数据，描述为 system.vanish 的记录
sdkLog.critical('system.vanish', {
    // debug infos here
});
```

### 5. 读取日志

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

### 6. 清理日志

```javascript
Logline.keep(0.5); // 保留半天以内的日志，如果不传参则清空日志
Logline.clean(); // 清空日志并删除数据库
```

自定义数据库名
---------

由于 indexeddb, websql 和 localStorage 都是同域共享的，这时候 Logline 默认的数据库名 logline 可能会已经被占用，需要指定一个新的数据库名。
可以通过下面2个方法指定数据库名。

```javascript
// 调用`using`时，同时指定第二个参数作为数据库名
Logline.using(Logline.PROTOCOL.WEBSQL, 'newlogline');

// 调用`database`来指定数据库名
Logline.database('newlogline');
```

自定义构建
--------

目前Logline一共实现了`localstorage`、`websql`和`indexeddb`三个日志协议，默认是全部打包，可能你只想使用其中某个协议而已，你可以通过`npm run configure`和`npm run build`来自定义构建你需要的版本。这样有利于减小包的大小。

```shell
// 不跟参数默认构建所有协议
npm run configure
// 配置你需要的协议，去掉不需要的协议申明--with-xxx
npm run configure -- --with-localstorage --with-websql

// 重新打包
npm run build
// 去dist目录寻找新构建的打包文件
```

FAQ
----

### 如何上传日志？

从v1.0.1以开始，日志上传功能被移除，我们希望logline更专注于日志的记录和维护工作，
你可以通过`Logline.all`和`Logline.get`来获取日志来自行实现上传过程。

[travis-image]: https://api.travis-ci.org/latel/logline.svg
[travis-url]: https://travis-ci.org/latel/logline
