// Section.tsx — generic wrapper used by every generated section component.
// gives each section an entry animation tied to viewport visibility, and
// renders the framer html via dangerouslySetInnerHTML so the original markup
// (with framer's inline styles + classes) keeps working.

import { useRef } from "react";
import { motion, useInView, type Variants, type Transition } from "framer-motion";

export interface SectionProps {
  html: string;
  framerName?: string;
  variants?: Variants;
  transition?: Transition;
  /** disable the entry animation entirely (handy when iterating) */
  static?: boolean;
}

const defaultVariants: Variants = {
  hidden:  { opacity: 0, y: 40 },
  visible: { opacity: 1, y: 0 },
};

const defaultTransition: Transition = {
  type: "spring",
  duration: 0.8,
  bounce: 0.3,
};

export function Section({
  html,
  framerName,
  variants = defaultVariants,
  transition = defaultTransition,
  static: isStatic = false,
}: SectionProps) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-10% 0% -10% 0%" });

  if (isStatic) {
    return <div data-section={framerName} dangerouslySetInnerHTML={{ __html: html }} />;
  }

  return (
    <motion.div
      ref={ref}
      data-section={framerName}
      variants={variants}
      initial="hidden"
      animate={inView ? "visible" : "hidden"}
      transition={transition}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
