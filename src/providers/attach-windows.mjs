import { connect } from 'node:net';

const socket = connect('/tmp/nod-paired-windows/current');
socket.on('error', () => {
  process.stderr.write(
    'Nod could not attach the Windows session. Check the server configuration.\n',
  );
  process.exitCode = 1;
});
socket.on('connect', () => {
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});
socket.on('close', () => process.stdin.destroy());
process.stdout.on('error', () => socket.destroy());
