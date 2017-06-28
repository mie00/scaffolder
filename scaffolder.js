var Promise = require('bluebird');
var fs = Promise.promisifyAll(require('fs'));
var path = require('path');
var _ = require('lodash');
var mkdirp = Promise.promisify(require('mkdirp'));

var config = {
    'dryrun': false,
    'encoding': 'binary',
    'files': {
        'scaffile': '.scaf',
        'scafout': '.scafout',
        'scafctx': '.scafctx',
    },
    'prefix': '-- ',
    'special': '_',
    'ignore': [],
};

var keys = {
    'key': config.special + 'k',
    'value': config.special + 'v',
    'self': config.special + 'self',
    'root': config.special + 'root',
    'parent': config.special + 'parent',
};

function ConflictingError(target, files) {
    this.message = "Multiple files writing to the same place: '" + target + "' => [" + files.join(', ') + "]";
    this.target = target;
    this.files = files;
    this.name = "ConflictingError";
    Error.captureStackTrace(this, ConflictingError);
}
ConflictingError.prototype = Object.create(Error.prototype);
ConflictingError.prototype.constructor = ConflictingError;

function NotFoundError(pa) {
    this.message = "No such file or directory: " + pa;
    this.pa = pa;
    this.name = "NotFoundError";
    Error.captureStackTrace(this, NotFoundError);
}
NotFoundError.prototype = Object.create(Error.prototype);
NotFoundError.prototype.constructor = NotFoundError;

var files = {};

function build_recursive(obj, reader, writer, pa, parentname) {
    if (parentname === undefined) {
        parentname = '';
    }
    return Promise.resolve(reader.isdir(pa))
        .then(isdir => {
            if (isdir) {
                if (utils_ignored(pa, 'dir')) {
                    return;
                }
                return build_dir(obj, reader, writer, pa, parentname);
            } else {
                if (utils_ignored(pa, 'file')) {
                    return;
                }
                return build_file(obj, reader, writer, pa, parentname);
            }
        });
}

function utils_create_kv(k, v) {
    var tmp = {};
    tmp[keys.key] = k;
    tmp[keys.value] = v;
    return tmp;
}

function utils_parse_scope(obj, scopestr) {
    /* jshint -W083 */
    var scope = scopestr.replace('[]', '.[]').replace('{}', '.{}').replace(/^\./, '').split('.');
    var res = [obj];
    var old;
    for (var ch of scope) {
        old = res;
        res = [];
        for (var e of old) {
            var subres = [];
            if (ch == '[]') {
                if (_.isArray(e)) {
                    subres = subres.concat(e);
                } else if (_.isObject(e)) {
                    subres = subres.concat(_.values(_.omit(e, _.values(keys))));
                }
            } else if (ch == '{}') {
                if (_.isArray(e[keys.self])) {
                    _.transform(e[keys.self], (res, v, k) => {
                        res.push(utils_create_kv(k, v));
                    }, subres);
                } else if (_.isObject(e[keys.self])) {
                    _.transform(_.omit(e[keys.self], _.values(keys)), (result, v, k) => {
                        result.push(utils_create_kv(k, v));
                    }, subres);
                }
            } else {
                subres.push(e[ch]);
            }
            for (var e2 of subres) {
                res.push(utils_normailze_elem(e2, e));
            }
        }
    }
    return res;
}

function utils_normailze_elem(elem, parent) {
    var root = parent?parent[keys.root] || parent:elem;
    if (!_.isObject(elem)) {
        var tmp = {};
        tmp[keys.self] = elem;
        elem = tmp;
    } else {
        elem[keys.self] = elem;
    }
    elem[keys.parent] = parent;
    elem[keys.root] = root;
    return elem;
}


function utils_parse_recursive(optss, res, include) {
    if (optss.length === 0)
        return res;
    var more = [];
    if (res === undefined) {
        res = [];
    }
    for (var opts of optss) {
        var tmp = utils_parse_once(opts, include);
        for (var parsed of tmp) {
            if (parsed.args.length === 0) {
                res.push(parsed);
            } else {
                more.push(parsed);
            }
        }
    }
    return utils_parse_recursive(more, res, include);
}

function utils_parse_once(opts, include) {
    var res = [];
    if (opts.args.length === 0)
        return [opts];

    var el = opts.args[0];
    var t;
    switch (el.type) {
        case 'scope':
            var ctxs = utils_parse_scope(opts.ctx, el.arg);
            for (var ctx of ctxs) {
                res.push({
                    'ctx': ctx,
                    'name': opts.name.slice(),
                    'args': opts.args.slice(1),
                    'orig': opts.orig.slice(),
                });
            }
            break;
        case 'cond':
            t = _.template(el.arg);
            var cond = t(opts.ctx);
            opts.args = opts.args.slice(1);
            if (cond)
                res = [opts];
            break;
        case 'includable':
            opts.args = opts.args.slice(1);
            if (include)
                res = [opts];
            break;
        case 'name':
            t = _.template(el.arg);
            var name = t(opts.ctx);
            opts.name.push(name);
            opts.args = opts.args.slice(1);
            res = [opts];
            break;
        default:
            // TODO: better error
            throw Error("Didn't understand: " + el.type);
    }
    return res;
}

function parse_scaf(content, originalname, obj, parentname, include) {
    var opts = {
        'ctx': obj,
        'name': [],
        'args': [],
        'orig': [],
    };

    // TODO: fix later, too slow
    var lines = content.split('\n');
    var template = false;
    for (var line of lines) {
        if (line.startsWith(config.prefix)) {
            line = line.substring(config.prefix.length);
            var tmp = line.split(' ');
            var op = tmp[0];
            var arg = tmp.length > 1?tmp.slice(1).join(' '):'';
            switch (op) {
                case 'template':
                    template = (arg == 'on')?true:false;
                    break;
                case 'scope':
                    opts.args.push({'arg': arg, 'type': 'scope'});
                    break;
                case 'cond':
                    opts.args.push({'arg': arg, 'type': 'cond'});
                    break;
                case 'includable':
                    opts.args.push({'type': 'includable'});
                    break;
                case 'include':
                    opts.orig.push({'arg': arg, 'type': 'include'});
                    break;
                case 'name':
                    opts.args.push({'arg': arg, 'type': 'name'});
                    break;
            }
        } else {
            opts.orig.push({'arg': line, 'type': template?'template':'literal'});
        }
    }
    return Promise.resolve(opts)
        .then(opts => {
            opts.ctx = utils_normailze_elem(opts.ctx);
            return utils_parse_recursive([opts], undefined, include);
        })
        .map(opts => {
            var name;
            if (opts.name.length === 0) {
                name = originalname;
            } else {
                opts.name = opts.name.filter(x => x);
                if (opts.name.length === 0) {
                    name = '';
                } else {
                    name = path.join.apply(path, opts.name);
                }
            }
            var wholename = path.join(parentname, name);
            return {
                'ctx': opts.ctx,
                'wholename': wholename,
                'orig': opts.orig,
            };
        });
}

function build_dir(obj, reader, writer, dir, parentname) {
    var scaf = path.join(dir, config.files.scaffile);
    return Promise.resolve(reader.exists(scaf))
        .then(e => {
            if (e) {
                return reader.read(scaf);
            } else {
                return '';
            }
        })
        .then(content => {
            return parse_scaf(content, dir, obj, parentname);
        })
        .map(opts => {
            return Promise.resolve(reader.ls(dir))
                .filter(x => (_.values(config.files).indexOf(x) == -1))
                .map(x => build_recursive(opts.ctx, reader, writer, path.join(dir, x), opts.wholename))
                .reduce((res, f) => {
                    return _.extend(res, f);
                }, {});
        })
        .reduce((res, f) => {
            return _.extend(res, f);
        }, {});
}

var fsreadable = {
    'read': function(file) {
        return fs.readFileAsync(path.join(this.base, file), config.encoding);
    },
    'isdir': function(pa) {
        return fs.statAsync(path.join(this.base,pa)).then(stat => stat.isDirectory());
    },
    'exists': function(pa) {
        return fs.accessAsync(path.join(this.base, pa), fs.constants.F_OK)
            .return(true)
            .catch(() => false);
    },
    'ls': function(dir) {
        return fs.readdirAsync(path.join(this.base, dir));
    },
};
var fswritable = {
    'write': function(file, content) {
        return fs.writeFileAsync(path.join(this.base, file), content, {'encoding': config.encoding});
    },
    'mkdirp': function(dir) {
        return mkdirp(path.join(this.base, dir));
    },
    'init': () => {},
    'commit': () => {},
};


var objreadable = {
    'read': function(file){
        var el = this.ro;
        var p = file.split('/').filter(x => ['', '.'].indexOf(x) === -1);
        for (var e of p) {
            el = el[e];
        }
        return el;
    },
    'isdir': function(pa){
        var el = this.ro;
        var p = pa.split('/').filter(x => ['', '.'].indexOf(x) === -1);
        for (var e of p) {
            el = el[e];
        }
        return _.isObject(el);
    },
    'exists': function(pa){
        var el = this.ro;
        var p = pa.split('/').filter(x => ['', '.'].indexOf(x) === -1);
        for (var e of p) {
            el = el[e];
            if (el === undefined)
                return false;
        }
        return true;
    },
    'ls': function(dir){
        var el = this.ro;
        var p = dir.split('/').filter(x => ['', '.'].indexOf(x) === -1);
        for (var e of p) {
            el = el[e];
        }
        return _.keys(el);
    },
};
var objwritable = {
    'write': function(file, content){
        var el = this.wo;
        var p = file.split('/').filter(x => ['', '.'].indexOf(x) === -1);
        var par = p.slice(0, -1);
        for (var e of par) {
            el = el[e];
        }
        // TODO: raise if it is a dir
        el[p.pop()] = content;
    },
    'mkdirp': function(dir) {
        var el = this.wo;
        var p = dir.split('/').filter(x => ['', '.'].indexOf(x) === -1);
        for (var e of p) {
            if (el[e] === undefined)
                el[e] = {};
            // TODO: raise if a file
            el = el[e];
        }
    },
    'init': () => {},
    'commit': () => {},
};

var Catcher = function() {
    this.called = false;
    this.error = false;
    this.mkdirp = function(){};
    this.write = function(_, data) {
        if (this.called == false) {
            this.called = true;
            this.data = data;
        } else {
            this.error = true;
        }
    };
};

function utils_include(ctx, reader, file, template) {
   var catcher = new Catcher();
   return build_file(ctx, reader, catcher, file, '', true)
       .then(_ => {
           if (catcher.error) {
               // TODO: fix
               throw new Error();
           }
           if (!catcher.called) {
               // TODO: fix
               throw new Error();
           }
           return catcher.data;
    });
}

function build_file(obj, reader, writer, file, parentname, include) {
    return Promise.resolve(reader.read(file))
        .then(content => {
            return parse_scaf(content, file, obj, parentname, include);
        })
        .map(opts => {
            if (files[opts.wholename] === undefined) {
                files[opts.wholename] = file;
            } else {
                throw new ConflictingError(opts.wholename, [files[opts.wholename], file]);
            }
            var wholename = opts.wholename;
            return Promise.resolve(opts.orig)
                .map(i => {
                    if (i.type == 'include') {
                        return utils_include(opts.ctx, reader, i.arg)
                            .then(data => {
                                return {'type': 'include', 'arg': data};
                            });

                    } else {
                        return i;
                    }
                })
                .then(is => {
                    var result = [];
                    var tmp = [];
                    var template = false;
                    var nexttemplate;
                    var cont;
                    for (var i of is) {
                        nexttemplate = (i.type == 'template')?true:(i.type == 'literal')?false:template;
                        if (template != nexttemplate) {
                            if (tmp.length) {
                                if (template == true) {
                                    cont = _.template(tmp.join('\n'));
                                    result.push(cont(opts.ctx));
                                } else {
                                    result.push(tmp.join('\n'));
                                }
                            }
                            tmp = [];
                            template = nexttemplate;
                        }
                        tmp.push(i.arg);
                    }
                    if (tmp.length) {
                        if (template == true) {
                            cont = _.template(tmp.join('\n'));
                            result.push(cont(opts.ctx));
                        } else {
                            result.push(tmp.join('\n'));
                        }
                    }
                    return result.join('\n');
                })
                .then(text => {
                    var ret = {};
                    var p = !config.dryrun?Promise.resolve(writer.mkdirp(path.dirname(wholename))):Promise.resolve();
                    return p.then(_ => {
                            if (!config.dryrun)
                                return writer.write(wholename, text);
                        })
                        .then(_ => {ret[wholename] = text; })
                        .return(ret);
                });
        })
        .reduce((res, f) => {
            return _.extend(res, f);
        }, {});
}

function utils_ignored(file, type) {
    // TODO: implement
    if (config.ignore.indexOf(path.basename(file)) != -1) {
        return true;
    }
    return false;
}

function build(obj, reader, writer, pa, parentname) {
    parentname = parentname || '.';
    pa = pa || '.';
    return Promise.resolve(writer.init())
        .then(_ => reader.exists(pa))
        .then(e => {
            if (e) {
                return build_recursive(obj, reader, writer, pa, parentname);
            } else {
                throw new NotFoundError(pa);
            }
        })
        .then(r => {
            return writer.commit();
        });
}

var ObjReader = function(ro) {
    this.ro = ro || {};
};
ObjReader.prototype = objreadable;
ObjReader.prototype.constructor = ObjReader;

var ObjWriter = function(wo) {
    this.wo = wo || {};
};
ObjWriter.prototype = objwritable;
ObjWriter.prototype.constructor = ObjWriter;

var JsonReader = function(file) {
    this.ro = {};
    this.file = file;
    this.init = () => {
        return fs.readFileAsync(this.file, config.encoding)
            .then(JSON.parse)
            .then(json => {this.ro = json;});
    };
};
JsonReader.prototype = objreadable;
JsonReader.prototype.constructor = JsonReader;

var JsonWriter = function(file) {
    this.wo = {};
    this.file = file || config.files.scafout;
    this.commit = () => {
        return fs.writeFileAsync(this.file, JSON.stringify(this.wo), {'encoding': config.encoding})
            .return(this.wo);
    };
};
JsonWriter.prototype = objwritable;
JsonWriter.prototype.constructor = JsonWriter;


var YamlWriter = function(file) {
    var yaml = require('js-yaml');
    this.wo = {};
    this.file = file || config.files.scafout;
    this.commit = () => {
        return fs.writeFileAsync(this.file, yaml.dump(this.wo), {'encoding': config.encoding})
            .return(this.wo);
    };
};
YamlWriter.prototype = objwritable;
YamlWriter.prototype.constructor = YamlWriter;

var FsReader = function(base) {
    this.base = base;
};
FsReader.prototype = fsreadable;
FsReader.prototype.constructor = FsReader;

var FsWriter = function(base) {
    this.base = base;
};
FsWriter.prototype = fswritable;
FsWriter.prototype.constructor = FsWriter;

function main(args) {
    var defaultargs = {
        'reader': 'fs',
        'writer': 'yaml',
        'in': '.',
        'out': config.files.scafout,
        'ctx': config.files.scafctx,
    };
    args = _.extend(defaultargs, args);
    var reader = args.reader === 'json'?new JsonReader(args['in']):new FsReader(args['in']);
    var writer = args.writer === 'json'?new JsonWriter(args.out):args.writer == 'yaml'?new YamlWriter(args.out):new FsWriter(args.out);
    return fs.readFileAsync(args.ctx, config.encoding)
        .then(JSON.parse)
        .then(ctx => build(ctx, reader, writer));
}

module.exports = {
    'config': config,
    'errors': {
        'NotFoundError': NotFoundError,
        'ConflictingError': ConflictingError,
    },
    'readers': {
        'fs': FsReader,
        'json': JsonReader,
        'obj': ObjReader,
    },
    'writers': {
        'fs': FsWriter,
        'json': JsonWriter,
        'obj': ObjWriter,
    },
    'build': build,
    'main': main,
};
