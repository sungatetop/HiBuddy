/**
 * Markdown renderer for butler messages (ADR-011 message surface).
 *
 * Text the butler writes is Markdown: headings, lists, links, tables, inline
 * code and fenced blocks. Raw HTML is NOT enabled (react-markdown ignores it
 * without rehype-raw), so model/worker output cannot inject markup.
 */

import type { CSSProperties, ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const S = {
  paragraph: { margin: '0 0 6px' } as CSSProperties,
  heading: { margin: '10px 0 6px', fontSize: 15, fontWeight: 600 } as CSSProperties,
  list: { margin: '4px 0', paddingLeft: 20 } as CSSProperties,
  item: { margin: '2px 0' } as CSSProperties,
  quote: {
    margin: '6px 0',
    padding: '2px 10px',
    borderLeft: '3px solid #d9d9d9',
    color: '#666666',
  } as CSSProperties,
  rule: { border: 'none', borderTop: '1px solid #e5e5e5', margin: '8px 0' } as CSSProperties,
  link: { color: '#0b7d3e', textDecoration: 'underline', wordBreak: 'break-all' } as CSSProperties,
  inlineCode: {
    padding: '1px 4px',
    borderRadius: 4,
    background: 'rgba(0,0,0,0.06)',
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
    fontSize: 12.5,
  } as CSSProperties,
  codeBlock: {
    margin: '6px 0',
    padding: '8px 10px',
    borderRadius: 6,
    background: '#f6f6f6',
    overflowX: 'auto',
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
    fontSize: 12.5,
    lineHeight: 1.5,
  } as CSSProperties,
  table: { borderCollapse: 'collapse', margin: '6px 0', fontSize: 13 } as CSSProperties,
  cell: { border: '1px solid #e2e2e2', padding: '4px 8px', textAlign: 'left' } as CSSProperties,
  image: { maxWidth: '100%', borderRadius: 6, display: 'block', margin: '4px 0' } as CSSProperties,
}

/** True when a `code` child is a fenced block (already inside `pre`). */
function isBlockCode(className: string | undefined, children: ReactNode): boolean {
  if (className !== undefined && className.includes('language-')) return true
  return String(children ?? '').includes('\n')
}

export function Markdown({ children }: { children: string }): ReactNode {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children: content }) => <p style={S.paragraph}>{content}</p>,
        h1: ({ children: content }) => <div style={{ ...S.heading, fontSize: 17 }}>{content}</div>,
        h2: ({ children: content }) => <div style={{ ...S.heading, fontSize: 16 }}>{content}</div>,
        h3: ({ children: content }) => <div style={S.heading}>{content}</div>,
        h4: ({ children: content }) => <div style={S.heading}>{content}</div>,
        h5: ({ children: content }) => <div style={S.heading}>{content}</div>,
        h6: ({ children: content }) => <div style={S.heading}>{content}</div>,
        ul: ({ children: content }) => <ul style={S.list}>{content}</ul>,
        ol: ({ children: content }) => <ol style={S.list}>{content}</ol>,
        li: ({ children: content }) => <li style={S.item}>{content}</li>,
        blockquote: ({ children: content }) => <blockquote style={S.quote}>{content}</blockquote>,
        hr: () => <hr style={S.rule} />,
        a: ({ href, children: content }) => (
          <a href={href} target="_blank" rel="noreferrer noopener" style={S.link}>
            {content}
          </a>
        ),
        table: ({ children: content }) => <table style={S.table}>{content}</table>,
        th: ({ children: content }) => (
          <th style={{ ...S.cell, background: '#fafafa', fontWeight: 600 }}>{content}</th>
        ),
        td: ({ children: content }) => <td style={S.cell}>{content}</td>,
        img: ({ src, alt }) => <img src={src} alt={alt ?? ''} style={S.image} />,
        pre: ({ children: content }) => <pre style={S.codeBlock}>{content}</pre>,
        code: ({ className, children: content }) =>
          isBlockCode(className, content) ? (
            <code style={{ font: 'inherit' }}>{content}</code>
          ) : (
            <code style={S.inlineCode}>{content}</code>
          ),
      }}
    >
      {children}
    </ReactMarkdown>
  )
}
