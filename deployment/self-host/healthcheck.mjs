import http from 'node:http';

const origin = new URL(
  process.env.NOD_PUBLIC_URL || `http://localhost:${process.env.PORT || 4310}`,
);
const request = http.get(
  {
    hostname: '127.0.0.1',
    port: process.env.PORT || 4310,
    path: '/api/health',
    headers: { host: origin.host, authorization: `Bearer ${process.env.NOD_AUTH_TOKEN}` },
    timeout: 5000,
  },
  (response) => {
    response.resume();
    process.exitCode = response.statusCode === 200 ? 0 : 1;
  },
);
request.on('timeout', () => request.destroy());
request.on('error', () => {
  process.exitCode = 1;
});
