'use strict';
// cPanel/Passenger startup entrypoint.
require('./src/index.js').main().catch(() => { process.exitCode = 1; });
