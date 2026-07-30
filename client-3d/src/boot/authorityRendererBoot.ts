export interface AuthorityRendererBootParams<Authority, Chat, Renderer, ViewInterest> {
  createAuthority: (getViewInterest: () => ViewInterest | null) => Authority;
  createChat: () => Chat;
  connectChat: (chat: Chat) => void;
  waitForAuthority: (authority: Authority) => Promise<void>;
  createRenderer: () => Promise<Renderer>;
  getViewInterest: (renderer: Renderer) => ViewInterest | null;
  assertAuthorityReady?: (authority: Authority) => void;
  closeAuthority?: (authority: Authority) => void;
  closeChat?: (chat: Chat) => void;
}

/**
 * Starts game and chat transports before the renderer and keeps view-interest
 * nullable until the renderer has finished its expensive creation work.
 */
export async function createAuthorityBeforeRenderer<Authority, Chat, Renderer, ViewInterest>(
  params: AuthorityRendererBootParams<Authority, Chat, Renderer, ViewInterest>,
): Promise<{ authority: Authority; chat: Chat; renderer: Renderer }> {
  let renderer: Renderer | null = null;
  const authority = params.createAuthority(() => (
    renderer === null ? null : params.getViewInterest(renderer)
  ));
  let chat: Chat | null = null;
  try {
    const createdChat = params.createChat();
    chat = createdChat;
    params.connectChat(createdChat);
    await params.waitForAuthority(authority);
    params.assertAuthorityReady?.(authority);
    renderer = await params.createRenderer();
    return { authority, chat: createdChat, renderer };
  } catch (error) {
    params.closeAuthority?.(authority);
    if (chat !== null) params.closeChat?.(chat);
    throw error;
  }
}
