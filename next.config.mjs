/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: '/awsops',
  env: {
    NEXT_PUBLIC_DOCS_URL: process.env.NEXT_PUBLIC_DOCS_URL || 'https://whchoi98.github.io/awsops',
  },
  webpack: (config) => {
    // CLAUDE.md docs live alongside code under src/; dynamic imports like
    // `@/lib/collectors/${route}` make webpack scan the whole directory,
    // so .md files must be treated as plain text, not parsed as modules.
    config.module.rules.push({ test: /\.md$/, type: 'asset/source' });
    return config;
  },
};

export default nextConfig;
