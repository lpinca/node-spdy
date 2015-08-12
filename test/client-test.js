var assert = require('assert');
var https = require('https');
var transport = require('spdy-transport');

var fixtures = require('./fixtures');
var spdy = require('../');

describe('SPDY Client', function() {
  fixtures.everyProtocol(function(protocol, npn, version) {
    var server;
    var agent;

    beforeEach(function(done) {
      server = spdy.createServer(fixtures.keys, function(req, res) {
        var body = '';
        req.on('data', function(chunk) {
          body += chunk;
        });
        req.on('end', function() {
          res.writeHead(200, req.headers);
          res.addTrailers({ trai: 'ler' });

          var push = res.push('/push', {
            request: {
              push: 'yes'
            }
          }, function(err) {
            assert(!err);

            push.end('push');
            push.on('error', function() {
            });

            res.end(body || 'okay');
          });
        });
      });

      server.listen(fixtures.port, function() {
        agent = spdy.createAgent({
          rejectUnauthorized: false,
          port: fixtures.port,
          spdy: {
            protocols: [ npn ]
          }
        });

        done();
      });
    });

    afterEach(function(done) {
      var waiting = 2;
      agent.close(next);
      server.close(next);

      function next() {
        if (--waiting === 0)
          done();
      }
    });

    it('should send GET request', function(done) {
      var req = https.request({
        agent: agent,

        method: 'GET',
        path: '/get',
        headers: {
          a: 'b'
        }
      }, function(res) {
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers.a, 'b');

        fixtures.expectData(res, 'okay', done);
      });
      req.end();
    });

    it('should send POST request', function(done) {
      var req = https.request({
        agent: agent,

        method: 'POST',
        path: '/post'
      }, function(res) {
        assert.equal(res.statusCode, 200);

        fixtures.expectData(res, 'post body', done);
      });
      req.end('post body');
    });

    it('should receive PUSH_PROMISE', function(done) {
      var req = https.request({
        agent: agent,

        method: 'GET',
        path: '/get'
      }, function(res) {
        assert.equal(res.statusCode, 200);

        res.resume();
      });
      req.on('push', function(push) {
        assert.equal(push.path, '/push');
        assert.equal(push.headers.push, 'yes');

        push.resume();
        push.once('end', done);
      });
      req.end();
    });

    it('should receive trailing headers', function(done) {
      var req = https.request({
        agent: agent,

        method: 'GET',
        path: '/get'
      }, function(res) {
        assert.equal(res.statusCode, 200);

        res.on('trailers', function(headers) {
          assert.equal(headers.trai, 'ler');
          fixtures.expectData(res, 'okay', done);
        });
      });
      req.end();
    });
  });
});