const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const testFiles = fs.readdirSync(__dirname)
    .filter((filename) => filename.endsWith('.test.js'))
    .sort();

for (const filename of testFiles) {
    console.log(`\nRunning ${filename}`);
    const result = spawnSync(process.execPath, [path.join(__dirname, filename)], {
        stdio: 'inherit'
    });

    if (result.error) {
        console.error(`Failed to run ${filename}: ${result.error.message}`);
        process.exitCode = 1;
        break;
    }
    if (result.status !== 0) {
        process.exitCode = result.status || 1;
        break;
    }
}