import { Cluster, PageHeader, Section, Stack } from './index';

export default { title: 'Layout/Page primitives' };

export const Page = () => (
  <div className="bg-canvas p-6">
    <Stack className="mx-auto max-w-3xl" gap={6}>
      <PageHeader
        title="Explore providers"
        subtitle="Compare the models available to this workspace."
        primaryAction={
          <button className="rounded-pill bg-primary px-3 py-2 text-label text-primary-foreground">
            Add provider
          </button>
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
