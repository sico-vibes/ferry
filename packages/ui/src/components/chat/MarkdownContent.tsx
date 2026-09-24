import { Children, isValidElement, useEffect, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Clipboard } from 'lucide-react';
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
            <pre>
              <CodeBlock
                {...(child.props.className ? { className: child.props.className } : {})}
                code={(typeof code === 'string' || typeof code === 'number'
                  ? String(code)
                  : ''
                ).replace(/\n$/, '')}
              />
            </pre>
          );
        },
        code: ({ children, className }) => (
          <code className={cn(className, 'rounded-md bg-raised px-1.5 py-0.5 font-mono')}>
            {children}
          </code>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

function CodeBlock({ code, className }: { code: string; className?: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [theme, setTheme] = useState(() =>
    typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light'
      ? 'github-light-default'
      : 'github-dark-default',
  );
  const language = /language-(\w+)/.exec(className ?? '')?.[1] ?? 'text';
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
            .replace(/background-color:[^;]+;/, 'background-color:var(--bg-card);'),
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
    <code className={cn(className, 'relative block font-mono text-[12px] leading-5')}>
      <button
        aria-label="Copy code"
        className={`absolute right-2 top-2 z-10 rounded-md bg-raised p-1.5 text-text-2 opacity-0 transition hover:opacity-100 focus:opacity-100 ${focusRingClass}`}
        onClick={() => {
          void navigator.clipboard.writeText(code);
        }}
        type="button"
      >
        <Clipboard size={14} />
      </button>
      {html ? <span dangerouslySetInnerHTML={{ __html: html }} /> : code}
    </code>
  );
}
