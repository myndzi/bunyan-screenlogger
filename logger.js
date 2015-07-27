/**
 * Copyright (c) 2014 Trent Mick. All rights reserved.
 * Copyright (c) 2014 Joyent Inc. All rights reserved.
 *
 * bunyan -- filter and pretty-print Bunyan log files (line-delimited JSON)
 *
 * See <https://github.com/trentm/node-bunyan>.
 *
 * -*- mode: js -*-
 * vim: expandtab:ts=4:sw=4
 */

var VERSION = '1.2.4';

var util = require('util');
var pathlib = require('path');
var vm = require('vm');
var http = require('http');
var fs = require('fs');
var warn = console.warn;
var child_process = require('child_process'),
    spawn = child_process.spawn,
    exec = child_process.exec,
    execFile = child_process.execFile;
var assert = require('assert');

var nodeSpawnSupportsStdio = (
    Number(process.version.split('.')[0]) >= 0 ||
    Number(process.version.split('.')[1]) >= 8);

var Transform = require('stream').Transform;


//---- globals and constants

// Internal debug logging via `console.warn`.
var _DEBUG = false;

// Output modes.
var OM_LONG = 1;
var OM_JSON = 2;
var OM_INSPECT = 3;
var OM_SIMPLE = 4;
var OM_SHORT = 5;
var OM_BUNYAN = 6;
var OM_FROM_NAME = {
    'long': OM_LONG,
    'paul': OM_LONG,  /* backward compat */
    'json': OM_JSON,
    'inspect': OM_INSPECT,
    'simple': OM_SIMPLE,
    'short': OM_SHORT,
    'bunyan': OM_BUNYAN
};


// Levels
var TRACE = 10;
var DEBUG = 20;
var INFO = 30;
var WARN = 40;
var ERROR = 50;
var FATAL = 60;

var levelFromName = {
    'trace': TRACE,
    'debug': DEBUG,
    'info': INFO,
    'warn': WARN,
    'error': ERROR,
    'fatal': FATAL
};
var nameFromLevel = {};
var upperNameFromLevel = {};
var upperPaddedNameFromLevel = {};
var prefixFromLevel = {};
Object.keys(levelFromName).forEach(function (name) {
    var lvl = levelFromName[name];
    nameFromLevel[lvl] = name;
    upperNameFromLevel[lvl] = name.toUpperCase();
    upperPaddedNameFromLevel[lvl] = (
        name.length === 4 ? ' ' : '') + name.toUpperCase();
    prefixFromLevel[lvl] = name.slice(0, 1);
});

// The current raw input line being processed. Used for `uncaughtException`.
var currLine = null;

// Child dtrace process, if any. Used for signal-handling.
var child = null;

// Whether ANSI codes are being used. Used for signal-handling.
var usingAnsiCodes = false;

// Global ref to options used only by 'uncaughtException' handler.
var gOptsForUncaughtException;

// Pager child process, and output stream to which to write.
var pager = null;
var stdout = process.stdout;

// Whether we are reading from stdin.
var readingStdin = false;



//---- support functions

function getVersion() {
    return VERSION;
}

function getTime(ts) {
    return ('0'+ts.getHours()).slice(-2) + ':' +
           ('0'+ts.getMinutes()).slice(-2) +  '.' +
           ('0'+ts.getSeconds()).slice(-2);
}
function getDate(ts) {
    return ts.getFullYear() + '.' +
          (ts.getMonth()+1) + '.' + 
           ts.getDate()
}

var format = util.format;
if (!format) {
    /* BEGIN JSSTYLED */
    // If not node 0.6, then use its `util.format`:
    // <https://github.com/joyent/node/blob/master/lib/util.js#L22>:
    var inspect = util.inspect;
    var formatRegExp = /%[sdj%]/g;
    format = function format(f) {
        if (typeof f !== 'string') {
            var objects = [];
            for (var i = 0; i < arguments.length; i++) {
                objects.push(inspect(arguments[i]));
            }
            return objects.join(' ');
        }

        var i = 1;
        var args = arguments;
        var len = args.length;
        var str = String(f).replace(formatRegExp, function (x) {
            if (i >= len)
                return x;
            switch (x) {
                case '%s': return String(args[i++]);
                case '%d': return Number(args[i++]);
                case '%j': return JSON.stringify(args[i++]);
                case '%%': return '%';
                default:
                    return x;
            }
        });
        for (var x = args[i]; i < len; x = args[++i]) {
            if (x === null || typeof x !== 'object') {
                str += ' ' + x;
            } else {
                str += ' ' + inspect(x);
            }
        }
        return str;
    };
    /* END JSSTYLED */
}

function indent(s) {
    return '    ' + s.split(/\r?\n/).join('\n    ');
}

function objCopy(obj) {
    if (obj === null) {
        return null;
    } else if (Array.isArray(obj)) {
        return obj.slice();
    } else {
        var copy = {};
        Object.keys(obj).forEach(function (k) {
            copy[k] = obj[k];
        });
        return copy;
    }
}

function isInteger(s) {
    return (s.search(/^-?[0-9]+$/) == 0);
}


// http://en.wikipedia.org/wiki/ANSI_escape_code#graphics
// Suggested colors (some are unreadable in common cases):
// - Good: cyan, yellow (limited use), bold, green, magenta, red
// - Bad: blue (not visible on cmd.exe), grey (same color as background on
//   Solarized Dark theme from <https://github.com/altercation/solarized>, see
//   issue #160)
var colors = {
    'bold' : [1],
    'italic' : [3],
    'underline' : [4],
    'inverse' : [7, 1, 31, 47],
    'white' : [37],
    'WHITE' : [1, 37],
    'black' : [30],
    'BLACK' : [1, 30],
    'blue' : [34],
    'cyan' : [36],
    'green' : [32],
    'GREEN' : [1, 32],
    'magenta' : [35],
    'red' : [31],
    'RED' : [1, 31],
    'yellow' : [33],
};
var colorFromLevel = {
    10: 'WHITE',    // TRACE
    20: 'green',    // DEBUG
    30: 'cyan',     // INFO
    40: 'yellow',   // WARN
    50: 'RED',      // ERROR
    60: 'inverse',  // FATAL
};

/**
 * Is this a valid Bunyan log record.
 */
function isValidRecord(rec) {
    if (rec.v == null ||
            rec.level == null ||
            rec.name == null ||
            rec.hostname == null ||
            rec.pid == null ||
            rec.time == null ||
            rec.msg == null) {
        // Not valid Bunyan log.
        return false;
    } else {
        return true;
    }
}
var minValidRecord = {
    v: 0,   //TODO: get this from bunyan.LOG_VERSION
    level: INFO,
    name: 'name',
    hostname: 'hostname',
    pid: 123,
    time: Date.now(),
    msg: 'msg'
};


var TS_PADDING = '         ';

function Logger(opts) {
    opts = opts || { };
    
    Transform.call(this);
    
    this._writableState.objectMode = true;
    
    if (opts.hasOwnProperty('color')) {
        this.color = opts.color;
    }
    
    this.stylize = (this.color ? this.stylizeWithColor : this.stylizeWithoutColor);

    this.lastDay = null;
    this.lastTime = null;
    
    var om = parseInt(opts.outputMode, 10);
    if (isNaN(om)) { om = OM_FROM_NAME[opts.outputMode]; }
    if (!om) { om = OM_LONG; }
    
    this.outputMode = om;
    this.jsonIndent = !!opts.jsonIndent;
}
util.inherits(Logger, Transform);

Logger.prototype.prependTimestamp = function (ts, str) {
    str = str || '';
    str = str.split(/\r?\n/).filter(function (a) { return a; }).join('\n' + TS_PADDING);
    
    var time = getTime(ts), date = getDate(ts);
    
    if (this.lastDate !== date) {
        this.lastDate = date;
        this.push(this.stylize('---' + date + '---', 'GREEN') + '\n');
    }
    if (this.lastTime === time) {
        this.push(TS_PADDING + str + '\n');
    } else {
        this.lastTime = time;
        this.push(this.stylize(time, 'GREEN') + ' ' + str + '\n');
    }
};
Logger.prototype.stylizeWithColor = function (str, color) {
    if (!str)
        return '';
    
    var codes = colors[color];
    if (codes) {
        return '\033[' + codes.join(';') + 'm' + str + '\033[0m';
    } else {
        return str;
    }
};
Logger.prototype.stylizeWithoutColor = function (str, color) {
    return str;
};

/**
 * Print out a single result, considering input options.
 */
Logger.prototype._transform = function (rec, encoding, cb) {
    var short = false;

    switch (this.outputMode) {
    case OM_SHORT:
        short = true;
        /* jsl:fall-thru */

    case OM_LONG:
        //    [time] LEVEL: name[/comp]/pid on hostname (src): msg* (extras...)
        //        msg*
        //        --
        //        long and multi-line extras
        //        ...
        // If 'msg' is single-line, then it goes in the top line.
        // If 'req', show the request.
        // If 'res', show the response.
        // If 'err' and 'err.stack' then show that.
        var ts = new Date(rec.time);
        
        if (isNaN(ts.getSeconds())) {
            ts = new Date();
        }
        if (!isValidRecord(rec)) {
            this.prependTimestamp(ts, rec);
            break;
        }
        delete rec.v;
        delete rec.time;

        var nameStr = this.stylize(rec.name, colorFromLevel[rec.level]);
        delete rec.name;

        if (rec.component) {
            nameStr += '/' + rec.component;
        }
        delete rec.component;

        if (!short)
            nameStr += '/' + rec.pid;
        delete rec.pid;

        var level = '[' + (prefixFromLevel[rec.level] || rec.level) + '] ';
        level = this.stylize(level, colorFromLevel[rec.level]);
        
        delete rec.level;

        var src = '';
        if (rec.src && rec.src.file) {
            var s = rec.src;
            if (s.func) {
                src = format(' (%s:%d in %s)', s.file, s.line, s.func);
            } else {
                src = format(' (%s:%d)', s.file, s.line);
            }
            src = this.stylize(src, 'green');
        }
        delete rec.src;

        var hostname = rec.hostname;
        delete rec.hostname;

        var extras = [];
        var details = [];

        if (rec.req_id) {
            extras.push('req_id=' + rec.req_id);
        }
        delete rec.req_id;

        var onelineMsg = '';
        if (rec.msg.indexOf('\n') !== -1) {
            details.push(rec.msg);
        } else {
            onelineMsg = rec.msg;
        }
        delete rec.msg;

        if (rec.req && typeof (rec.req) === 'object') {
            var req = rec.req;
            delete rec.req;
            var headers = req.headers;
            if (!headers) {
                headers = '';
            } else if (typeof (headers) === 'string') {
                headers = '\n' + headers;
            } else if (typeof (headers) === 'object') {
                headers = '\n' + Object.keys(headers).map(function (h) {
                    return h + ': ' + headers[h];
                }).join('\n');
            }
            var s = format('%s %s HTTP/%s%s', req.method,
                req.url,
                req.httpVersion || '1.1',
                headers
            );
            delete req.url;
            delete req.method;
            delete req.httpVersion;
            delete req.headers;
            if (req.body) {
                s += '\n\n' + (typeof (req.body) === 'object'
                    ? JSON.stringify(req.body, null, 2) : req.body);
                delete req.body;
            }
            if (req.trailers && Object.keys(req.trailers) > 0) {
                s += '\n' + Object.keys(req.trailers).map(function (t) {
                    return t + ': ' + req.trailers[t];
                }).join('\n');
            }
            delete req.trailers;
            details.push(s);
            // E.g. for extra 'foo' field on 'req', add 'req.foo' at
            // top-level. This *does* have the potential to stomp on a
            // literal 'req.foo' key.
            Object.keys(req).forEach(function (k) {
                rec['req.' + k] = req[k];
            })
        }

        if (rec.client_req && typeof (rec.client_req) === 'object') {
            var client_req = rec.client_req;
            delete rec.client_req;
            var headers = client_req.headers;
            var hostHeaderLine = '';
            var s = '';
            if (client_req.address) {
                hostHeaderLine = 'Host: ' + client_req.address;
                if (client_req.port)
                    hostHeaderLine += ':' + client_req.port;
                hostHeaderLine += '\n';
            }
            delete client_req.headers;
            delete client_req.address;
            delete client_req.port;
            s += format('%s %s HTTP/%s\n%s%s', client_req.method,
                client_req.url,
                client_req.httpVersion || '1.1',
                hostHeaderLine,
                (headers ?
                    Object.keys(headers).map(
                        function (h) {
                            return h + ': ' + headers[h];
                        }).join('\n') :
                    ''));
            delete client_req.method;
            delete client_req.url;
            delete client_req.httpVersion;
            if (client_req.body) {
                s += '\n\n' + (typeof (client_req.body) === 'object' ?
                    JSON.stringify(client_req.body, null, 2) :
                    client_req.body);
                delete client_req.body;
            }
            // E.g. for extra 'foo' field on 'client_req', add
            // 'client_req.foo' at top-level. This *does* have the potential
            // to stomp on a literal 'client_req.foo' key.
            Object.keys(client_req).forEach(function (k) {
                rec['client_req.' + k] = client_req[k];
            })
            details.push(s);
        }

        function _res(res) {
            var s = '';
            if (res.statusCode !== undefined) {
                s += format('HTTP/1.1 %s %s\n', res.statusCode,
                    http.STATUS_CODES[res.statusCode]);
                delete res.statusCode;
            }
            // Handle `res.header` or `res.headers` as either a string or
            // and object of header key/value pairs. Prefer `res.header` if set
            // (TODO: Why? I don't recall. Typical of restify serializer?
            // Typical JSON.stringify of a core node HttpResponse?)
            var headers;
            if (res.header !== undefined) {
                headers = res.header;
                delete res.header;
            } else if (res.headers !== undefined) {
                headers = res.headers;
                delete res.headers;
            }
            if (!headers) {
                /* pass through */
            } else if (typeof (headers) === 'string') {
                s += headers.trimRight();
            } else {
                s += Object.keys(headers).map(
                    function (h) { return h + ': ' + headers[h]; }).join('\n');
            }
            if (res.body !== undefined) {
                s += '\n\n' + (typeof (res.body) === 'object'
                    ? JSON.stringify(res.body, null, 2) : res.body);
                delete res.body;
            } else {
                s = s.trimRight();
            }
            if (res.trailer) {
                s += '\n' + res.trailer;
            }
            delete res.trailer;
            if (s) {
                details.push(s);
            }
            // E.g. for extra 'foo' field on 'res', add 'res.foo' at
            // top-level. This *does* have the potential to stomp on a
            // literal 'res.foo' key.
            Object.keys(res).forEach(function (k) {
                rec['res.' + k] = res[k];
            });
        }

        if (rec.res && typeof (rec.res) === 'object') {
            _res(rec.res);
            delete rec.res;
        }
        if (rec.client_res && typeof (rec.client_res) === 'object') {
            _res(rec.client_res);
            delete rec.res;
        }

        if (rec.err && rec.err.stack) {
            var err = rec.err
            details.push(err.stack);
            delete err.message;
            delete err.name;
            delete err.stack;
            // E.g. for extra 'foo' field on 'err', add 'err.foo' at
            // top-level. This *does* have the potential to stomp on a
            // literal 'err.foo' key.
            Object.keys(err).forEach(function (k) {
                rec['err.' + k] = err[k];
            })
            delete rec.err;
        }

        var leftover = Object.keys(rec);
        if (leftover.length) {
            details.push(
                indent(
                    util.inspect(rec, { depth: null, colors: true })
                )
            );
        }

        var hostnameStr = this.stylize(hostname || '<unknown>', 'GREEN');
        
        extras = (extras.length ? '(' + extras.join(', ') + ')' : '');
        details = (details.length ? details.join('\n') : '');
        if (onelineMsg.length) { extras = ' ' + extras; }
        
        if (!short)
            this.prependTimestamp(ts, format('%s%s on %s%s: %s%s\n%s',
                level,
                nameStr,
                hostnameStr,
                src,
                onelineMsg,
                extras,
                details));
        else
            this.prependTimestamp(ts, format('%s%s: %s%s\n%s',
                level,
                nameStr,
                onelineMsg,
                extras,
                details));
        break;

    case OM_INSPECT:
        this.push(util.inspect(rec, false, Infinity, true) + '\n');
        break;

    case OM_BUNYAN:
        this.push(JSON.stringify(rec, null, 0) + '\n');
        break;

    case OM_JSON:
        this.push(JSON.stringify(rec, null, this.jsonIndent) + '\n');
        break;

    case OM_SIMPLE:
        /* JSSTYLED */
        // <http://logging.apache.org/log4j/1.2/apidocs/org/apache/log4j/SimpleLayout.html>
        if (!isValidRecord(rec)) {
            this.push(line + '\n');
            break;
        }
        this.push(format('%s - %s\n',
            upperNameFromLevel[rec.level] || 'LVL' + rec.level,
            rec.msg)+'\n');
        break;
    default:
        throw new Error('unknown output mode: '+this.outputMode);
    }
    return cb();
}
module.exports = Logger;
