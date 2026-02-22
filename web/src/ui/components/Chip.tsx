import React from "react";
import styles from "./Chip.module.css";

export function Chip({
  active,
  mono,
  className,
  children,
}: {
  active?: boolean;
  mono?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const classes = [
    styles.chip,
    active ? styles.active : null,
    mono ? styles.mono : null,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return <span className={classes}>{children}</span>;
}
