import { posix } from 'node:path';

/** Map public Markdown sources to their English and Chinese site routes. */
export const documentationRoute = (source) => {
  if (source === 'LICENSE') return 'LICENSE.txt';
  if (source === 'README.md') return 'index.md';
  if (source === 'README.zh-CN.md') return 'zh/index.md';
  return source.endsWith('.zh-CN.md') ? `zh/${source.replace('.zh-CN.md', '.md')}` : source;
};

/** Preserve external URLs and anchors while resolving relative links against the original source location. */
export const rewriteDocumentationLinks = (content, source, sources) =>
  content.replace(/\]\(([^\s)]+)\)/g, (match, href) => {
    if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(href)) return match;
    const [path, anchor] = href.split('#', 2);
    const destination = posix.normalize(posix.join(posix.dirname(source), path));
    if (!sources.has(destination)) return match;
    const route = posix.relative(posix.dirname(documentationRoute(source)), documentationRoute(destination));
    return `](${route}${anchor === undefined ? '' : `#${anchor}`})`;
  });
