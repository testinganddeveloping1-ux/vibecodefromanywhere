import React from "react";
import styles from "./Modal.module.css";

export function Modal({
  open,
  wide,
  children,
}: {
  open: boolean;
  wide?: boolean;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div className={styles.overlay} role="dialog" aria-modal="true">
      <div className={[styles.panel, wide ? styles.wide : null].filter(Boolean).join(" ")}>
        {children}
      </div>
    </div>
  );
}

export function ModalHeader({ children }: { children: React.ReactNode }) {
  return <div className={styles.header}>{children}</div>;
}

export function ModalBody({ children }: { children: React.ReactNode }) {
  return <div className={styles.body}>{children}</div>;
}

export function ModalSpacer() {
  return <div className={styles.spacer} />;
}
