// Removes the Windows service installed by install-service.js.
const Service = require('node-windows').Service;
const path = require('path');

const svc = new Service({
  name: 'M365-Sphere',
  script: path.join(__dirname, 'server.js'),
  workingDirectory: __dirname
});
svc.on('uninstall', () => console.log('Service uninstalled.'));
svc.on('error', e => console.error(e));
svc.uninstall();
