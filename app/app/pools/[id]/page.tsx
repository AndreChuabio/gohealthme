import PoolDetail from "@/components/PoolDetail";

export default async function PoolPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PoolDetail id={id} />;
}
