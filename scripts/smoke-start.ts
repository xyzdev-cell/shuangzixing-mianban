process.env.HUGGING_FACE = '0';
process.env.GITHUB_PROJECT = '';
process.env.GITHUB_PROJECT_PAT = '';
process.env.GITHUB_ENCRYPT_KEY = '';
process.env.PORT = process.env.PORT || '0';

setTimeout(() => {
  process.exit(0);
}, 3000);

await import('../src/index.js');
