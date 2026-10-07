import Image from "next/image";
import trufinityLogo from "../../../public/images/trufinity-logo.png";

export function Logo({
  className = "",
  variant = "dark",
  imgClassName = "h-9 w-auto",
}: {
  className?: string;
  variant?: "dark" | "light";
  imgClassName?: string;
}) {
  const logoImg = (
    <Image
      src={trufinityLogo}
      alt="TruFinity Plumbing Heating & Cooling"
      className={imgClassName}
      priority
    />
  );

  if (variant === "light") {
    return (
      <div className={`inline-flex items-center rounded-lg bg-white px-3 py-1.5 ${className}`}>
        {logoImg}
      </div>
    );
  }

  return <div className={`inline-flex items-center ${className}`}>{logoImg}</div>;
}
