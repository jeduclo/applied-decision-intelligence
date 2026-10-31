import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeHighlight from "rehype-highlight";
import { slugify } from "@/lib/slug";

type HastNode = { type: string; value?: string; children?: HastNode[] };

function textOf(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

const components: Components = {
  h2: ({ node, children }) => <h2 id={slugify(textOf(node as HastNode))}>{children}</h2>,
  // "Question it answers" boxes get their own style
  blockquote: ({ node, children }) => {
    const isQuestion = textOf(node as HastNode).trimStart().startsWith("Question it answers");
    return <blockquote className={isQuestion ? "qbox" : undefined}>{children}</blockquote>;
  },
  a: ({ href, children }) => {
    const external = href?.startsWith("http");
    return (
      <a href={href} {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>
        {children}
      </a>
    );
  },
};

/** Renders the course's Markdown notes (trusted content written for this course). */
export default function Markdown({ source }: { source: string }) {
  return (
    <div className="notes">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeHighlight, { detect: false }]]}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
