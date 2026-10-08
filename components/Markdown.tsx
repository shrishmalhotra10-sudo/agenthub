'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Renders agent replies. Raw HTML is never rendered (react-markdown escapes it).
 * Images are shown as links instead of loading automatically: an agent tricked by
 * a malicious file could otherwise leak data through an image URL the browser fetches.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose prose-zinc max-w-none text-[15px] dark:prose-invert prose-pre:bg-zinc-900 prose-pre:text-zinc-100">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow">
              {children}
            </a>
          ),
          img: ({ src, alt }) => (
            <a href={typeof src === 'string' ? src : undefined} target="_blank" rel="noopener noreferrer nofollow">
              [image: {alt || 'link'}]
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
