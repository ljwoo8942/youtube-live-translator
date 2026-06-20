declare namespace chrome {
  namespace runtime {
    type MessageSender = {
      tab?: tabs.Tab;
      id?: string;
      url?: string;
    };

    type ExtensionContext = {
      contextTypes?: string[];
      documentUrls?: string[];
    };

    const id: string;
    const lastError: { message?: string } | undefined;

    function getURL(path: string): string;
    function openOptionsPage(): Promise<void>;
    function sendMessage<T = unknown>(message: unknown): Promise<T>;
    function getContexts(filter: ExtensionContext): Promise<unknown[]>;

    const onMessage: {
      addListener(
        callback: (
          message: unknown,
          sender: MessageSender,
          sendResponse: (response?: unknown) => void
        ) => boolean | void
      ): void;
    };
  }

  namespace storage {
    type AccessLevel = "TRUSTED_CONTEXTS" | "TRUSTED_AND_UNTRUSTED_CONTEXTS";

    type StorageArea = {
      get<T = Record<string, unknown>>(keys?: string | string[] | Record<string, unknown> | null): Promise<T>;
      set(items: Record<string, unknown>): Promise<void>;
      setAccessLevel(details: { accessLevel: AccessLevel }): Promise<void>;
    };

    const local: StorageArea;

    const onChanged: {
      addListener(
        callback: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, areaName: string) => void
      ): void;
    };
  }

  namespace tabs {
    type Tab = {
      id?: number;
      url?: string;
      title?: string;
      active?: boolean;
      windowId?: number;
    };

    function query(queryInfo: Record<string, unknown>): Promise<Tab[]>;
    function sendMessage<T = unknown>(tabId: number, message: unknown): Promise<T>;
  }

  namespace tabCapture {
    type CaptureInfo = {
      tabId: number;
      status: "pending" | "active" | "stopped" | "error";
      fullscreen?: boolean;
    };

    function getMediaStreamId(options?: Record<string, unknown>): Promise<string>;
    function getCapturedTabs(callback: (result: CaptureInfo[]) => void): void;
  }

  namespace offscreen {
    function createDocument(parameters: { url: string; reasons: string[]; justification: string }): Promise<void>;
    function closeDocument(): Promise<void>;
  }
}
