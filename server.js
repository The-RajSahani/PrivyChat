'use strict';
// Local development only. Vercel uses the root index.js entry point.
const app = require('./index.js');
const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`PrivyChat running at http://localhost:${port}`);
});
