import { useState } from "react";
import type { Book } from "../../shared/contracts";
import { api } from "../api";
import { Dialog } from "./Dialog";
type Metadata = Pick<
  Book,
  "title" | "author" | "language" | "translator" | "edition" | "identifier"
>;
export function BookDetails({
  book,
  onClose,
  onSaved,
}: {
  book: Book;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [value, setValue] = useState<Metadata>({
    title: book.title,
    author: book.author,
    language: book.language === "und" ? "" : book.language,
    translator: book.translator ?? "",
    edition: book.edition ?? "",
    identifier: book.identifier ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fields: { key: keyof Metadata; label: string; max: number }[] = [
    { key: "title", label: "书名", max: 500 },
    { key: "author", label: "作者", max: 500 },
    { key: "translator", label: "译者", max: 500 },
    { key: "edition", label: "版本／出版信息", max: 1000 },
    { key: "language", label: "语言", max: 100 },
    { key: "identifier", label: "ISBN／出版物标识", max: 500 },
  ];
  async function save() {
    if (!value.title.trim()) {
      setError("请填写书名。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.bookMetadata(book.id, value);
      await onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title="书籍资料"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p className="muted">
        资料来自
        EPUB。缺失的信息可以补充；这些修改不会改变书籍文件、指纹或已有引用。
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="product-book-fields">
          {fields.map((field) => (
            <label className="product-field" key={field.key}>
              {field.label}
              <input
                aria-label={field.label}
                value={value[field.key] ?? ""}
                placeholder="未知"
                maxLength={field.max}
                required={field.key === "title"}
                disabled={busy}
                onChange={(event) =>
                  setValue((previous) => ({
                    ...previous,
                    [field.key]: event.target.value,
                  }))
                }
              />
            </label>
          ))}
        </div>
        {error && (
          <p role="alert" className="product-error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            className="outline"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="submit"
            className="primary"
            disabled={busy || !value.title.trim()}
          >
            {busy ? "正在保存…" : "保存资料"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
