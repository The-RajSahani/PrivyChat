'use strict';
// Local development entry point only. Vercel uses api/index.js directly.
const path = require('path');
const app = require('./api/index.js');
app.use(require('express').static(path.join(__dirname)));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`PrivyChat running at http://localhost:${port}`));
