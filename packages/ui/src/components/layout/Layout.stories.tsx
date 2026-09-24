import { Cluster, PageHeader, Section, Stack } from './index';

export default { title: 'Layout/Page primitives' };

export const Page = () => (
  <div className="bg-canvas p-6">
    <Stack className="mx-auto max-w-3xl" gap={6}>
      <PageHeader
        eyebrow="WORKSPACE"
        title="Explore providers"
        subtitle="Compare the models available to this workspace."
        actions={
          <button className="rounded-pill bg-blue-500 px-3 py-2 text-label">Add provider</button>
        }
        nav={
          <Cluster gap={2}>
            <button>Providers</button>
            <button>Usage</button>
          </Cluster>
        }
      />
      <Section title="Available models">
        <Cluster gap={3}>
          <span>Free models</span>
          <span>12 providers</span>
          <span>Updated just now</span>
        </Cluster>
      </Section>
    </Stack>
  </div>
);
