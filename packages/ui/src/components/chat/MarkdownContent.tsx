import { Children, isValidElement, useEffect, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Clipboard } from 'lucide-react';
import { cn } from '../../lib/cn';
import { focusRingClass } from '../primitives';

let highlighterPromise:
  Promise<Awaited<ReturnType<typeof import('shiki/core').createHighlighterCore>>> | undefined;
function loadHighlighter() {
  highlighterPromise ??= Promise.all([
    import('shiki/core'),
    import('shiki/engine/javascript'),
    import('shiki/langs/tsx.mjs'),
    import('shiki/langs/ts.mjs'),
    import('shiki/langs/js.mjs'),
    import('shiki/langs/json.mjs'),
    import('shiki/langs/bash.mjs'),
    import('shiki/langs/python.mjs'),
    import('shiki/langs/diff.mjs'),
    import('shiki/themes/github-dark-default.mjs'),
    import('shiki/themes/github-light-default.mjs'),
  ]).then(([core, engine, tsx, ts, js, json, bash, python, diff, darkTheme, lightTheme]) =>
    core.createHighlighterCore({
      themes: [darkTheme.default, lightTheme.default],
      langs: [
        tsx.default,
        ts.default,
        js.default,
        json.default,
        bash.default,
        python.default,
        diff.default,
      ],
      engine: engine.createJavaScriptRegexEngine(),
    }),
  );
  return highlighterPromise;
}

export function MarkdownContent({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        pre: ({ children }) => {
          const child = Children.toArray(children)[0];
          if (!isValidElement<{ children?: ReactNode; className?: string }>(child))
            return <pre>{children}</pre>;
          const code = child.props.children;
          return (
            <CodeBlock
              {...(child.props.className ? { className: child.props.className } : {})}
              code={(typeof code === 'string' || typeof code === 'number'
                ? String(code)
                : ''
              ).replace(/\n$/, '')}
            />
          );
        },
        code: ({ children, className }) => (
          <code className={cn(className, 'rounded-md bg-raised px-1.5 py-0.5 font-mono')}>
            {children}
          </code>
        ),
      }}
    >
      {normalizeFencedCode(content)}
    </ReactMarkdown>
  );
}

export function normalizeFencedCode(content: string): string {
  return content.replace(/([^\n])([ \t]*)```(?=[\w+-]*\r?\n)/g, '$1\n\n```');
}

/** Lines shown before a long snippet collapses behind "Show more". */
const COLLAPSED_LINES = 24;

function CodeBlock({ code, className }: { code: string; className?: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [theme, setTheme] = useState(() =>
    typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light'
      ? 'github-light-default'
      : 'github-dark-default',
  );
  const language = /language-(\w+)/.exec(className ?? '')?.[1] ?? 'text';
  const lineCount = code.split('\n').length;
  const long = lineCount > COLLAPSED_LINES;
  useEffect(() => {
    const root = document.documentElement;
    const updateTheme = () => {
      setTheme(root.dataset.theme === 'light' ? 'github-light-default' : 'github-dark-default');
    };
    const observer = new MutationObserver(updateTheme);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      observer.disconnect();
    };
  }, []);
  useEffect(() => {
    let mounted = true;
    void loadHighlighter().then((highlighter) => {
      if (!mounted) return;
      try {
        setHtml(
          highlighter
            .codeToHtml(code, { lang: language, theme })
            .replace(/background-color:[^;]+;/, 'background-color:transparent;'),
        );
      } catch {
        setHtml('');
      }
    });
    return () => {
      mounted = false;
    };
  }, [code, language, theme]);
  return (
    <div className={cn('code-block', long && !expanded && 'is-collapsed')}>
      <div className="code-block-header">
        <span>{language === 'text' ? 'Code' : language}</span>
        <button
          aria-label={copied ? 'Copied' : 'Copy code'}
          className={`code-block-copy ${focusRingClass}`}
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true);
              window.setTimeout(() => {
                setCopied(false);
              }, 1500);
            });
          }}
          type="button"
        >
          {copied ? <Check size={14} /> : <Clipboard size={14} />}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <div className={cn(className, 'code-block-body')}>
        {html ? (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre>
            <code>{code}</code>
          </pre>
        )}
      </div>
      {long && (
        <button
          className={`code-block-more ${focusRingClass}`}
          onClick={() => {
            setExpanded(!expanded);
          }}
          type="button"
        >
          {expanded ? 'Show less' : `Show all ${String(lineCount)} lines`}
        </button>
      )}
    </div>
  );
}
