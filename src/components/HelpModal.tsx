import { CircleHelp, X } from "lucide-react";
import { type ReactNode, useEffect, useId } from "react";
import { createPortal } from "react-dom";

interface HelpModalProps {
  open: boolean;
  title: string;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  id?: string;
  closeLabel?: string;
  onClose(): void;
}

function portalTarget(): Element {
  return document.querySelector("main.main-view") ?? document.querySelector(".main-view") ?? document.body;
}

export function HelpModal({
  open,
  title,
  children,
  className,
  contentClassName,
  id,
  closeLabel,
  onClose
}: HelpModalProps) {
  const generatedId = useId();
  const modalId = id ?? `help-modal-${generatedId}`;
  const titleId = `${modalId}-title`;

  useEffect(() => {
    if (!open) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className={["modal-panel", className].filter(Boolean).join(" ")}
        id={modalId}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div className="modal-title">
            <CircleHelp size={18} />
            <h2 id={titleId}>{title}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label={closeLabel ?? "Close help"}>
            <X size={16} />
          </button>
        </div>
        <div className={contentClassName}>{children}</div>
      </section>
    </div>,
    portalTarget()
  );
}
