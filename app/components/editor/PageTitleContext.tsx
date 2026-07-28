"use client";

import { createContext, useContext } from "react";

/**
 * The current page's title, for anything that serializes the document for the
 * model. Code and math blocks build their own completion context from deep
 * inside the editor tree and have no other route to a page-level fact.
 */
const PageTitleContext = createContext<string>("");

export const PageTitleProvider = PageTitleContext.Provider;

export const usePageTitle = () => useContext(PageTitleContext);
