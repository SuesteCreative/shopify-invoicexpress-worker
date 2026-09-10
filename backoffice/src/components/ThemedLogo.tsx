import Image from "next/image";

type Props = {
  /** Artwork drawn for the dark skin. */
  nightSrc: string;
  /** The same mark drawn for the light skin. */
  daySrc: string;
  alt: string;
  width: number;
  height: number;
  className?: string;
  priority?: boolean;
};

/**
 * A logo that ships as two files, one drawn light and one drawn ink.
 *
 * These marks are not monochrome — the Rioko wordmark carries brand cyan and the
 * Kapta one a red dot — so a CSS invert() would recolour the brand, not just the
 * lettering. Both files are rendered instead and CSS shows whichever the active
 * skin needs. That keeps it correct on the very first paint, needs no client
 * state, and works in a server component. Only one is ever displayed, so
 * assistive tech reads the alt once.
 */
export function ThemedLogo({
  nightSrc,
  daySrc,
  alt,
  width,
  height,
  className,
  priority,
}: Props) {
  const shared = className ? ` ${className}` : "";
  return (
    <>
      <Image
        src={nightSrc}
        alt={alt}
        width={width}
        height={height}
        priority={priority}
        className={`art-night${shared}`}
      />
      <Image
        src={daySrc}
        alt={alt}
        width={width}
        height={height}
        priority={priority}
        className={`art-day${shared}`}
      />
    </>
  );
}
