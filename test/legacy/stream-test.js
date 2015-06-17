var assert = require('assert'),
    zlib = require('zlib'),
    spdy = require('../../'),
    keys = require('../fixtures/keys'),
    https = require('https'),
    util = require('util'),
    Buffer = require('buffer').Buffer,
    PORT = 8081;

describe('A SPDY Server / Stream', function() {
  var server;
  var agent;
  var pair = null;

  describe('normal', function() {
    run({});
  });
  describe('maxChunk = false', function() {
    run({ maxChunk: false });
  });

  function run(options) {
    beforeEach(function(done) {
      var waiting = 2;
      pair = { server: null, client: null };

      server = spdy.createServer(util._extend(keys, options),
                                 function(req, res) {
        assert.equal(req.method, 'POST');
        pair.server = { req: req, res: res };

        // Just to remove junk from stream's buffer
        if (spdy.utils.isLegacy)
          req.once('data', function(data) {
            assert.equal(data.toString(), 'shame');
            if (--waiting === 0)
              done();
          });
        else
          req.once('readable', function() {
            assert.equal(req.read().toString(), 'shame');
            if (--waiting === 0)
              done();
          });

        res.writeHead(200);
      });

      server.listen(PORT, function() {
        agent = spdy.createAgent({
          host: '127.0.0.1',
          port: PORT,
          rejectUnauthorized: false
        });

        pair.client = {
          req: https.request({
            path: '/',
            method: 'POST',
            agent: agent
          }, function(res) {
            pair.client.res = res;
            if (--waiting === 0)
              done();
          }),
          res: null
        };
        pair.client.req.write('shame');
      });
    });

    afterEach(function(done) {
      pair = null;
      agent.close(function() {
        server.close(done);
      });
    });

    it('should support PING from client', function(done) {
      agent.ping(done);
    });

    it('should support PING from server', function(done) {
      pair.server.res.socket.ping(done);
    });

    it('piping a lot of data', function(done) {
      var big = new Buffer(2 * 1024 * 1024);
      for (var i = 0; i < big.length; i++)
        big[i] = ~~(Math.random() * 256);

      var offset = 0;
      if (spdy.utils.isLegacy) {
        pair.client.res.on('data', function(chunk) {
          for (var i = 0; i < chunk.length; i++) {
            assert(i + offset < big.length);
            assert.equal(big[i + offset], chunk[i]);
          }
          offset += i;
        });
      } else {
        pair.client.res.on('readable', function() {
          var bigEcho = pair.client.res.read(big.length);
          if (bigEcho) {
            assert.equal(big.length, bigEcho.length);
            for (var i = 0; i < big.length; i += 256) {
              assert.equal(big.slice(i, i + 256).toString('hex'),
                           bigEcho.slice(i, i + 256).toString('hex'));
            }
            offset += bigEcho.length;
          }
        });
      }
      pair.client.res.on('end', function() {
        assert.equal(offset, big.length);
        done();
      });

      pair.server.req.pipe(pair.server.res);
      pair.client.req.end(big);
    });

    it('destroy in the middle', function(done) {
      var big = new Buffer(2 * 1024 * 1024);
      for (var i = 0; i < big.length; i++)
        big[i] = ~~(Math.random() * 256);

      var offset = 0;
      pair.server.req.on('data', function(chunk) {
        for (var i = 0; i < chunk.length; i++) {
          assert(i + offset < big.length);
          assert.equal(big[i + offset], chunk[i]);
        }
        offset += i;
      });

      pair.server.req.on('close', function() {
        assert(offset < big.length);
        done();
      });

      pair.client.req.write(big.slice(0, big.length >> 1));
      pair.client.req.write(big.slice(big.length >> 1));
      pair.client.req.socket.destroy();
    });

    it('destroySoon in the middle', function(done) {
      var big = new Buffer(2 * 1024 * 1024);
      for (var i = 0; i < big.length; i++)
        big[i] = ~~(Math.random() * 256);

      var offset = 0;
      pair.server.req.on('data', function(chunk) {
        for (var i = 0; i < chunk.length; i++) {
          assert(i + offset < big.length);
          assert.equal(big[i + offset], chunk[i]);
        }
        offset += i;
      });

      pair.server.req.on('end', function() {
        assert.equal(offset, big.length);
        done();
      });

      pair.client.req.write(big.slice(0, big.length >> 1));
      pair.client.req.write(big.slice(big.length >> 1));
      pair.client.req.socket.destroySoon();
    });

    it('ending', function(done) {
      var data = '';
      pair.server.req.on('data', function(chunk) {
        data += chunk;
      });

      pair.server.req.on('end', function() {
        assert.equal(data, 'hello');
        pair.server.res.end();
        done();
      });

      pair.client.req.end('hello');
    });

    it('trailing headers from client', function(done) {
      pair.server.req.once('trailers', function(headers) {
        assert.equal(headers.wtf, 'yes');
        assert.equal(pair.server.req.trailers.wtf, 'yes');
        done();
      });
      pair.client.req.addTrailers({ wtf: 'yes' });
    });

    it('trailing headers from server', function(done) {
      pair.client.res.once('trailers', function(headers) {
        assert.equal(headers.wtf, 'yes');
        assert.equal(pair.client.res.trailers.wtf, 'yes');
        done();
      });
      pair.server.res.addTrailers({ wtf: 'yes' });
    });

    it('push stream', function(done) {
      agent.once('push', function(req) {
        var gotTrailers = false;
        assert.equal(req.headers.wtf, 'true');

        var chunks = '';
        req.once('data', function(chunk) {
          chunks += chunk;
        });
        req.once('trailers', function(trailers) {
          assert.equal(trailers.ok, 'yes');
          gotTrailers = true;
        });
        req.once('end', function() {
          assert(gotTrailers);
          assert.equal(req.trailers.ok, 'yes');
          assert.equal(chunks, 'yes, wtf');
          done();
        });
      });

      pair.server.res.push('/wtf', { wtf: true }, function(err, stream) {
        assert(!err);
        stream.on('error', function(err) {
          throw err;
        });
        stream.sendHeaders({ ok: 'yes' });
        stream.end('yes, wtf');
      });
    });

    it('push stream with compression', function(done) {
      agent.once('push', function(req) {
        req.once('data', function(chunk) {
          assert.equal(chunk.toString(), 'yes, wtf');
          done();
        });
      });
      pair.server.res.push('/wtf', {
        'Content-Encoding': 'gzip'
      }, function(err, stream) {
        assert(!err);
        stream.on('error', function(err) {
          throw err;
        });
        var gzip = zlib.createGzip();
        gzip.on('data', function(data) {
          stream.write(data);
        });
        gzip.on('end', function() {
          stream.end();
        });
        gzip.end('yes, wtf');
      });
    });

    it('push stream - big chunks', function(done) {
      var count = 10;
      var chunk = new Buffer(256 * 1024 - 7);
      for (var i = 0; i < chunk.length; i++)
        chunk[i] = ~~(Math.random() * 256);

      agent.once('push', function(req) {
        assert.equal(req.headers.wtf, 'true');
        var offset = 0;
        var total = 0;
        req.on('data', function(data) {
          for (var i = 0; i < data.length; i++) {
            assert.equal(data[i],
                         chunk[(offset + i) % chunk.length],
                         'Mismatch at: ' + (offset + i));
          }
          offset = (offset + i) % chunk.length;
          total += i;
        });
        req.once('end', function() {
          assert.equal(total, count * chunk.length);
          done();
        });
      });

      pair.server.res.push('/wtf', { wtf: true }, function(err, stream) {
        assert(!err);
        stream.on('error', function(err) {
          throw err;
        });

        function start(count) {
          if (count === 1)
            return stream.end(chunk);
          stream.write(chunk);
          setTimeout(function() {
            start(count - 1);
          }, 5);
        }
        start(count);
      });
    });

    it('push stream - early close', function(done) {
      agent.once('push', function(req) {
        var chunks = '';
        req.on('data', function(chunk) {
          chunks += chunk;
        });
        req.once('end', function() {
          assert.equal(chunks, 'yes, wtf');
          done();
        });
      });
      var stream = pair.server.res.push('/wtf', {});
      pair.client.res.on('data', function() {});
      pair.client.res.once('end', function() {
        stream.end('yes, wtf');
      });
      pair.client.req.end();
      pair.server.res.end();
    });

    it('timing out', function(done) {
      var data = '';

      pair.server.req.socket.setTimeout(300);
      pair.client.req.on('error', function() {
        done();
      });
    });

    it('timing out after write', function(done) {
      var data = '';
      var chunks = 0;

      pair.server.req.socket.setTimeout(150);
      setTimeout(function() {
        pair.server.res.write('ok1');
        setTimeout(function() {
          pair.server.res.write('ok2');
        }, 100);
      }, 100);

      pair.client.res.on('data', function(chunk) {
        chunk = chunk.toString();
        assert(chunks === 0 && chunk === 'ok1' ||
               chunks === 1 && chunk === 'ok2');
        chunks++;
      });

      pair.client.req.on('error', function() {
        assert.equal(chunks, 2);
        done();
      });
    });

    it('req[spdyVersion/streamID]', function(done) {
      var data = '';
      assert.equal(pair.server.req.spdyVersion, 3.1);
      assert(pair.server.req.streamID > 0);

      pair.server.req.resume();
      pair.server.req.on('end', function() {
        pair.server.res.end();
        done();
      });

      pair.client.req.end();
    });
  }
});