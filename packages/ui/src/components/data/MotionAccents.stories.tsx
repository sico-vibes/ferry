import { AnimatedList } from './AnimatedList';
import { CountUp } from './CountUp';
export default { title: 'Data/Recent chats motion' };
export const RecentChats = () => (
  <section className="w-72 space-y-3 rounded-panel bg-panel p-4">
    <h2 className="text-title font-semibold">Recent chats</h2>
    <p className="text-label text-text-3">420 steps left today</p>
    <AnimatedList>
      {['Fix flaky tests · api', 'Auth refactor · ferry-web', 'Add dark mode · dashboard'].map(
        (chat) => (
          <button className="w-full rounded-lg bg-white/[0.03] p-3 text-left text-label" key={chat}>
            {chat}
          </button>
        ),
      )}
    </AnimatedList>
    <p className="text-meta text-text-3">
      Animated counter: <CountUp to={4823} />
    </p>
  </section>
);
