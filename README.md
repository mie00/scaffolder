# Scaffolder

A directory templating language

## Installation

```bash
npm install mie00/scaffolder
```

## Example

```js
var Promise = require('bluebird');
var scaffolder = require('scaffolder');
var fs = Promise.promisifyAll(require('fs'));

var args = {
    'reader': 'fs',
    'writer': 'json',
    'in': '.',
    'out': scaffolder.config.files.scafout,
    'ctx': scaffolder.config.files.scafctx,
};
var reader = new scaffolder.FsReader(args['in']);
var writer = new scaffolder.JsonWriter(args.out);
return fs.readFileAsync(args.ctx, scaffolder.config.encoding)
    .then(JSON.parse)
    .then(ctx => scaffolder.build(ctx, reader, writer))
    .then(console.log)
```

## TODO

1. CLI tool
2. Diff writer (A writer that checks if it exists and try to apply the new changes only)
3. Unit tests
4. Add the ability to change the used templating language
5. NPM package

## LICENSE

[MIT](./LICENSE) © 2017 [Mohamed Elawadi](http://www.github.com/mie00)

