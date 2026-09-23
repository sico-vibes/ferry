import {
  CanvasHeaderActions,
  CanvasPanel,
  Composer,
  Disclaimer,
  Hero,
  ModelPickerTrigger,
  PinnedChatsRow,
  SuggestionChips,
} from './index';
export default { title: 'Layout/Canvas home' };
const cards = [
  {
    language: 'ts' as const,
    title: 'Auth refactor · ferry-web',
    snippet: 'Split session tokens by provider…',
    date: '2 hours ago',
  },
  {
    language: 'py' as const,
    title: 'Fix flaky tests · api',
    snippet: 'Retry timeout in async suite…',
    date: 'Yesterday',
  },
  {
    language: 'js' as const,
    title: 'Add dark mode · dashboard',
    snippet: 'Update theme tokens and charts…',
    date: 'Oct 2',
  },
  {
    language: 'go' as const,
    title: 'Improve request pooling',
    snippet: 'Keep connections warm…',
    date: 'Sep 28',
  },
];
export const Home = () => (
  <main className="h-[780px] w-[756px] bg-app p-3">
    <CanvasPanel
      className="h-full"
      header={
        <>
          <ModelPickerTrigger mode="auto" modelName="GLM-5.3" />
          <CanvasHeaderActions />
        </>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col justify-center">
        <Hero
          title={['Build bigger with Ferry — every free', 'model, one seamless task.']}
          subtitle="Ferry routes each step to the model that still has room, and carries your task across when one runs dry."
        />
        <PinnedChatsRow cards={cards} />
        <SuggestionChips />
      </div>
      <Composer
        banner={{
          text: 'Free capacity low — Gemini resets in 2h 13m',
          actionLabel: 'Add provider',
          onAction: () => undefined,
        }}
        onAttach={() => undefined}
        onChange={() => undefined}
        onProfileClick={() => undefined}
        onSend={() => undefined}
        onStop={() => undefined}
        profileName="Best Available"
        running={false}
        value=""
      />
      <Disclaimer />
    </CanvasPanel>
  </main>
);
