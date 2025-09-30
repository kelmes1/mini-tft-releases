// send-mqtt.js
// Robust MQTT over WSS publisher with retries and helpful logging.

const mqtt = require('mqtt');

const TARGET = process.env.MQTT_HOST;
const TOPIC = process.env.MQTT_PATH
const PAYLOAD = process.env.RELEASE_TAG || 'ci-test';
const USER = process.env.MQTT_USER;
const PASS = process.env.MQTT_PASSWORD;

if (!TARGET) {
  console.error('MQTT_HOST is not set!');
  process.exit(2);
}

const maxAttempts = Number(process.env.MQTT_ATTEMPTS || 4);
const baseDelayMs = Number(process.env.MQTT_RETRY_DELAY_MS || 3000);
const connectTimeout = Number(process.env.MQTT_CONNECT_TIMEOUT_MS || 15000);

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function publishOnce() {
  return new Promise((resolve, reject) => {
    const wsHeaders = {
      'sec-websocket-protocol': 'mqtt',
      'User-Agent': 'github-selfhosted-mqtt-publisher/1.0'
    };

    // If CF Access secrets are present (optional), include them
    if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
      wsHeaders['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID;
      wsHeaders['CF-Access-Client-Secret'] = process.env.CF_ACCESS_CLIENT_SECRET;
    }

    const options = {
      username: USER,
      password: PASS,
      connectTimeout: connectTimeout,
      reconnectPeriod: 0, // fail-fast in CI
      wsOptions: {
        headers: wsHeaders
      }
    };

    console.log('mqtt: connecting to', TARGET, 'with options:', {
      connectTimeout: options.connectTimeout,
      reconnectPeriod: options.reconnectPeriod
    });

    const client = mqtt.connect(TARGET, options);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      const err = new Error('connect timeout');
      console.error('mqtt: connect timed out after', connectTimeout, 'ms');
      try { client.end(true); } catch(e) {}
      reject(err);
    }, connectTimeout + 5000);

    client.on('connect', () => {
      if (timedOut) return;
      clearTimeout(timer);
      console.log('mqtt: connected — publishing to', TOPIC);
      client.publish(TOPIC, PAYLOAD, { qos: 1 }, (err) => {
        if (err) {
          console.error('mqtt: publish error', err);
          try { client.end(true); } catch(e) {}
          return reject(err);
        }
        console.log('mqtt: published', PAYLOAD, 'to', TOPIC);
        client.end(true, () => resolve({ ok: true }));
      });
    });

    client.on('error', (err) => {
      if (timedOut) return;
      clearTimeout(timer);
      console.error('mqtt: error event', err && err.message ? err.message : err);
      try { client.end(true); } catch(e) {}
      reject(err);
    });

    // If Cloudflare returns an HTTP response on the WebSocket upgrade, print it
    if (client.stream && client.stream.on) {
      client.stream.on('response', (res) => {
        console.warn('mqtt: HTTP response on websocket stream ->', res.statusCode);
        if (res.headers) console.warn('mqtt: response headers:', res.headers);
      });
    }
  });
}

(async () => {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`Attempt ${attempt}/${maxAttempts}`);
      await publishOnce();
      console.log('Done — exiting success.');
      process.exit(0);
    } catch (err) {
      console.error(`Attempt ${attempt} failed:`, (err && err.message) ? err.message : err);
      if (attempt < maxAttempts) {
        const backoff = baseDelayMs * Math.pow(2, attempt - 1);
        console.log(`Waiting ${backoff}ms before retrying...`);
        await sleep(backoff);
      } else {
        console.error('All attempts failed — exiting with error.');
        process.exit(1);
      }
    }
  }
})();
