import Navbar from '@/components/Navbar';

export default function LoginLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <Navbar user={null} showLogout={false} />
      <main className="flex-1 w-full">{children}</main>
    </>
  );
}
