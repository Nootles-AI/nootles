import { describe, expect, it } from "vitest";
import { notionPageIdFrom } from "./notionUrl";

const bare = "1a2b3c4d5e6f7081920334a5b6c7d8e9";
const dashed = "1a2b3c4d-5e6f-7081-9203-34a5b6c7d8e9";

describe("notionPageIdFrom", () => {
  it("reads the id this importer writes", () => {
    expect(notionPageIdFrom(`https://www.notion.so/${bare}`)).toBe(dashed);
  });

  it("reads the id off a titled URL a person would paste", () => {
    expect(notionPageIdFrom(`https://www.notion.so/Launch-Plan-${bare}`)).toBe(dashed);
  });

  it("ignores the query Notion appends to its own links", () => {
    expect(notionPageIdFrom(`https://www.notion.so/Plan-${bare}?pvs=4`)).toBe(dashed);
  });

  it("handles a workspace path and a published site", () => {
    expect(notionPageIdFrom(`https://www.notion.so/acme/Plan-${bare}`)).toBe(dashed);
    expect(notionPageIdFrom(`https://acme.notion.site/Plan-${bare}`)).toBe(dashed);
  });

  it("declines anything that is not a Notion page", () => {
    expect(notionPageIdFrom("https://example.com/notion.so/" + bare)).toBeNull();
    expect(notionPageIdFrom("https://www.notion.so/")).toBeNull();
    expect(notionPageIdFrom("https://www.notion.so/not-an-id")).toBeNull();
    expect(notionPageIdFrom("not a url")).toBeNull();
  });
});
