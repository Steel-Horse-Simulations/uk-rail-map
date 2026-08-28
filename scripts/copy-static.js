const fs = require('fs');
const path = require('path');
fs.mkdirSync('dist/renderer', { recursive: true });
for (const f of ['index.html', 'overview.html', 'styles.css']) {
  fs.copyFileSync(path.join('src/renderer', f), path.join('dist/renderer', f));
}
