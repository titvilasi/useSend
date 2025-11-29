"use client";

import {
  type ChangeEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@usesend/ui";
import { Button } from "@usesend/ui/src/button";
import { toast } from "@usesend/ui/src/toaster";
import { EditorContent, useEditor } from "@tiptap/react";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold,
  Braces,
  Code2,
  Eye,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  PenSquare,
  Redo2,
  Undo2,
} from "lucide-react";

type ComposerMode = "design" | "html" | "preview";

type EmailComposerProps = {
  value: string;
  onChange: (value: string) => void;
  variables?: string[];
  onUploadImage?: (file: File) => Promise<string>;
};

function replacePreviewVariables(
  content: string,
  variables?: Record<string, string>
) {
  if (!variables || Object.keys(variables).length === 0) {
    return content;
  }

  return Object.entries(variables).reduce((acc, [key, value]) => {
    const regex = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "gi");
    return acc.replace(regex, value);
  }, content);
}

export function EmailComposer({
  value,
  onChange,
  variables,
  onUploadImage,
}: EmailComposerProps) {
  const [mode, setMode] = useState<ComposerMode>("design");
  const [htmlValue, setHtmlValue] = useState(value || "");
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const htmlTextareaRef = useRef<HTMLTextAreaElement>(null);
  const skipNextUpdate = useRef(true);

  const previewVariables = useMemo(() => {
    if (!variables?.length) {
      return undefined;
    }

    return variables.reduce((acc, variable) => {
      const normalized = variable.toLowerCase();
      const fallback =
        normalized === "email"
          ? "customer@example.com"
          : normalized === "firstname"
            ? "Alex"
            : normalized === "lastname"
              ? "Smith"
              : variable;
      acc[variable] = fallback;
      return acc;
    }, {} as Record<string, string>);
  }, [variables]);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Link.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: { class: "text-primary underline" },
      }),
      Image.configure({
        HTMLAttributes: { class: "max-w-full rounded-md" },
      }),
      Placeholder.configure({
        placeholder: "Design your email content...",
      }),
    ],
    content: value || "<p></p>",
    onUpdate: ({ editor }) => {
      if (skipNextUpdate.current) {
        skipNextUpdate.current = false;
        return;
      }
      const html = editor.getHTML();
      setHtmlValue(html);
      onChange(html);
    },
  });

  useEffect(() => {
    if (!editor) {
      return;
    }
    if (value !== htmlValue) {
      skipNextUpdate.current = true;
      editor.commands.setContent(value || "<p></p>", false);
      setHtmlValue(value || "");
    }
  }, [editor, htmlValue, value]);

  const setLink = () => {
    const previousUrl = editor?.getAttributes("link").href;
    const url = window.prompt("Enter URL", previousUrl || "https://");

    if (url === null) {
      return;
    }

    if (url === "") {
      editor?.chain().focus().unsetLink().run();
      return;
    }

    editor
      ?.chain()
      .focus()
      .setLink({ href: url, target: "_blank" })
      .run();
  };

  const insertVariable = (variable: string) => {
    const token = `{{${variable}}}`;

    if (mode === "html" && htmlTextareaRef.current) {
      const textarea = htmlTextareaRef.current;
      const { selectionStart, selectionEnd } = textarea;
      const nextValue =
        htmlValue.slice(0, selectionStart) +
        token +
        htmlValue.slice(selectionEnd);

      setHtmlValue(nextValue);
      onChange(nextValue);
      skipNextUpdate.current = true;
      editor?.commands.setContent(nextValue || "<p></p>", false);

      requestAnimationFrame(() => {
        const cursor = selectionStart + token.length;
        textarea.selectionStart = cursor;
        textarea.selectionEnd = cursor;
      });
      return;
    }

    if (editor) {
      skipNextUpdate.current = true;
      editor.chain().focus().insertContent(token).run();
      const nextHtml = editor.getHTML();
      setHtmlValue(nextHtml);
      onChange(nextHtml);
      return;
    }

    const nextValue = htmlValue + token;
    setHtmlValue(nextValue);
    onChange(nextValue);
  };

  const handleImageUploadClick = () => {
    if (!onUploadImage) {
      return;
    }
    fileInputRef.current?.click();
  };

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    if (!onUploadImage) {
      return;
    }
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setIsUploading(true);
    try {
      const url = await onUploadImage(file);
      skipNextUpdate.current = true;
      editor
        ?.chain()
        .focus()
        .setImage({
          src: url,
          alt: file.name,
        })
        .run();
      const nextHtml = editor?.getHTML() ?? htmlValue;
      setHtmlValue(nextHtml);
      onChange(nextHtml);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to upload image",
      );
    } finally {
      setIsUploading(false);
      event.target.value = "";
    }
  };

  const previewHtml = useMemo(
    () => replacePreviewVariables(htmlValue, previewVariables),
    [htmlValue, previewVariables],
  );

  return (
    <div className="rounded-lg border bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex flex-wrap items-center gap-1 sm:gap-2">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className={cn(
              "h-8 w-8",
              editor?.isActive("bold") ? "bg-muted" : "",
            )}
            onClick={() => editor?.chain().focus().toggleBold().run()}
          >
            <Bold className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className={cn(
              "h-8 w-8",
              editor?.isActive("italic") ? "bg-muted" : "",
            )}
            onClick={() => editor?.chain().focus().toggleItalic().run()}
          >
            <Italic className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className={cn(
              "h-8 w-8",
              editor?.isActive("bulletList") ? "bg-muted" : "",
            )}
            onClick={() => editor?.chain().focus().toggleBulletList().run()}
          >
            <List className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className={cn(
              "h-8 w-8",
              editor?.isActive("orderedList") ? "bg-muted" : "",
            )}
            onClick={() => editor?.chain().focus().toggleOrderedList().run()}
          >
            <ListOrdered className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            onClick={setLink}
          >
            <LinkIcon className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            onClick={() => {
              editor?.chain().focus().undo().run();
            }}
          >
            <Undo2 className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            onClick={() => {
              editor?.chain().focus().redo().run();
            }}
          >
            <Redo2 className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className={cn(
              "h-8 w-8",
              mode === "html" ? "bg-muted text-foreground" : "",
            )}
            onClick={() => setMode("html")}
            aria-label="Switch to HTML"
          >
            <Code2 className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className={cn(
              "h-8 w-8",
              mode === "design" ? "bg-muted text-foreground" : "",
            )}
            onClick={() => setMode("design")}
            aria-label="Switch to design view"
          >
            <PenSquare className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className={cn(
              "h-8 w-8",
              mode === "preview" ? "bg-muted text-foreground" : "",
            )}
            onClick={() => setMode("preview")}
            aria-label="Preview HTML"
          >
            <Eye className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex items-center gap-2">
          {onUploadImage ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="gap-2"
              onClick={handleImageUploadClick}
              disabled={isUploading}
            >
              <ImageIcon className="h-4 w-4" />
              {isUploading ? "Uploading..." : "Upload image"}
            </Button>
          ) : null}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFileChange}
          />
        </div>
      </div>

      <div className="space-y-3 bg-gray-50 px-3 py-4 sm:px-6">
        {mode === "design" && editor ? (
          <div className="rounded-md border bg-white px-3 py-2">
            <EditorContent
              editor={editor}
              className="prose max-w-none min-h-[360px] focus:outline-none"
            />
          </div>
        ) : null}

        {mode === "html" ? (
          <textarea
            ref={htmlTextareaRef}
            value={htmlValue}
            onChange={(e) => {
              const updated = e.target.value;
              setHtmlValue(updated);
              skipNextUpdate.current = true;
              editor?.commands.setContent(updated || "<p></p>", false);
              onChange(updated);
            }}
            className="h-[360px] w-full rounded-md border bg-white px-3 py-2 font-mono text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-primary"
          />
        ) : null}

        {mode === "preview" ? (
          <div className="rounded-md border bg-white px-3 py-4 shadow-sm">
            <div
              className="prose max-w-none"
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          </div>
        ) : null}

        {variables?.length ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">Insert data:</span>
            {variables.map((variable) => (
              <Button
                key={variable}
                type="button"
                size="sm"
                variant="outline"
                className="gap-2 rounded-full border-dashed"
                onClick={() => insertVariable(variable)}
              >
                <Braces className="h-4 w-4" />
                {`{{${variable}}}`}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
