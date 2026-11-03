// CEF (Chromium/Blink) embedding for aiui: application class, browser client,
// and the aiui:// scheme that serves the web UI and bridges /api/* to Swift.

#import "AIUICef.h"

#include <mutex>
#include <string>
#include <vector>

#include "include/cef_app.h"
#import "include/cef_application_mac.h"
#include "include/cef_browser.h"
#include "include/cef_client.h"
#include "include/cef_parser.h"
#include "include/cef_resource_handler.h"
#include "include/cef_scheme.h"
#include "include/wrapper/cef_library_loader.h"

#include "AIUICefApp.h"

// MARK: - Application (CefAppProtocol)

@interface AIUIApplication () <CefAppProtocol> {
  BOOL handlingSendEvent_;
}
@end

@implementation AIUIApplication
- (BOOL)isHandlingSendEvent {
  return handlingSendEvent_;
}
- (void)setHandlingSendEvent:(BOOL)handlingSendEvent {
  handlingSendEvent_ = handlingSendEvent;
}
- (void)sendEvent:(NSEvent *)event {
  CefScopedSendingEvent sendingEventScoper;
  [super sendEvent:event];
}
// Cmd-Q and the Quit menu: close the browser first, CEF then ends the loop.
- (void)terminate:(id)sender {
  [AIUICef requestClose];
}
@end

// MARK: - Shared state

namespace {

CefScopedLibraryLoader *g_loader = nullptr;
CefRefPtr<CefBrowser> g_browser;
id<AIUIHost> g_host = nil;
NSString *g_web_root = nil;
bool g_quit_requested = false;

// Page background before the first paint, matching the system appearance (light or dark).
cef_color_t AppearanceBackground() {
  NSAppearanceName name = [NSApp.effectiveAppearance
      bestMatchFromAppearancesWithNames:@[ NSAppearanceNameDarkAqua, NSAppearanceNameAqua ]];
  return [name isEqualToString:NSAppearanceNameDarkAqua]
             ? CefColorSetARGB(255, 11, 11, 15)
             : CefColorSetARGB(255, 245, 245, 248);
}

std::string MimeFor(NSString *path) {
  NSString *ext = path.pathExtension.lowercaseString;
  NSDictionary *map = @{
    @"html" : @"text/html",
    @"js" : @"text/javascript",
    @"mjs" : @"text/javascript",
    @"css" : @"text/css",
    @"json" : @"application/json",
    @"svg" : @"image/svg+xml",
    @"png" : @"image/png",
    @"jpg" : @"image/jpeg",
    @"jpeg" : @"image/jpeg",
    @"woff2" : @"font/woff2",
  };
  NSString *m = map[ext] ?: @"application/octet-stream";
  return m.UTF8String;
}

// MARK: - aiui:// resource handler

class AIUIResourceHandler : public CefResourceHandler {
 public:
  bool Open(CefRefPtr<CefRequest> request, bool &handle_request,
            CefRefPtr<CefCallback> callback) override {
    CefURLParts parts;
    CefParseURL(request->GetURL(), parts);
    std::string path = CefString(&parts.path).ToString();
    NSString *nsPath = [NSString stringWithUTF8String:path.c_str()];

    if ([nsPath hasPrefix:@"/api/"]) {
      // Gather the POST body.
      std::vector<char> body;
      if (auto post = request->GetPostData()) {
        CefPostData::ElementVector elements;
        post->GetElements(elements);
        for (auto &el : elements) {
          size_t n = el->GetBytesCount();
          size_t off = body.size();
          body.resize(off + n);
          el->GetBytes(n, body.data() + off);
        }
      }
      NSData *data = [NSData dataWithBytes:body.data() length:body.size()];
      NSString *apiPath = [nsPath substringFromIndex:5];
      CefRefPtr<AIUIResourceHandler> self_ref(this);
      dispatch_async(dispatch_get_main_queue(), ^{
        if (!g_host) {
          self_ref->Finish(503, "text/plain", nil, callback);
          return;
        }
        [g_host handleAPI:apiPath
                     body:data
                    reply:^(NSInteger status, NSString *mime, NSData *out) {
                      self_ref->Finish((int)status, mime.UTF8String, out,
                                       callback);
                    }];
      });
      handle_request = false;  // async: callback->Continue() later
      return true;
    }

    // Static file from the web root.
    if ([nsPath isEqualToString:@"/"] || nsPath.length == 0)
      nsPath = @"/index.html";
    NSString *root = g_web_root.stringByStandardizingPath;
    NSString *file =
        [root stringByAppendingPathComponent:nsPath].stringByStandardizingPath;
    NSData *data = nil;
    if ([file hasPrefix:[root stringByAppendingString:@"/"]])
      data = [NSData dataWithContentsOfFile:file];
    std::lock_guard<std::mutex> lock(mu_);
    if (data) {
      status_ = 200;
      mime_ = MimeFor(file);
      data_.assign((const char *)data.bytes,
                   (const char *)data.bytes + data.length);
    } else {
      status_ = 404;
      mime_ = "text/plain";
      data_.assign({'n', 'o', 't', ' ', 'f', 'o', 'u', 'n', 'd'});
    }
    handle_request = true;
    return true;
  }

  void Finish(int status, const char *mime, NSData *data,
              CefRefPtr<CefCallback> callback) {
    {
      std::lock_guard<std::mutex> lock(mu_);
      status_ = status;
      mime_ = mime ? mime : "application/json";
      if (data)
        data_.assign((const char *)data.bytes,
                     (const char *)data.bytes + data.length);
    }
    callback->Continue();
  }

  void GetResponseHeaders(CefRefPtr<CefResponse> response,
                          int64_t &response_length,
                          CefString &redirect_url) override {
    std::lock_guard<std::mutex> lock(mu_);
    response->SetStatus(status_);
    response->SetMimeType(mime_);
    if (mime_.rfind("text/", 0) == 0 || mime_ == "application/json")
      response->SetCharset("utf-8");
    CefResponse::HeaderMap headers;
    headers.insert({"Cache-Control", "no-store"});
    response->SetHeaderMap(headers);
    response_length = (int64_t)data_.size();
  }

  bool Read(void *data_out, int bytes_to_read, int &bytes_read,
            CefRefPtr<CefResourceReadCallback> callback) override {
    std::lock_guard<std::mutex> lock(mu_);
    size_t left = data_.size() - offset_;
    if (left == 0) {
      bytes_read = 0;
      return false;
    }
    size_t n = std::min(left, (size_t)bytes_to_read);
    memcpy(data_out, data_.data() + offset_, n);
    offset_ += n;
    bytes_read = (int)n;
    return true;
  }

  void Cancel() override {}

 private:
  std::mutex mu_;
  int status_ = 200;
  std::string mime_ = "text/plain";
  std::vector<char> data_;
  size_t offset_ = 0;
  IMPLEMENT_REFCOUNTING(AIUIResourceHandler);
};

class AIUISchemeFactory : public CefSchemeHandlerFactory {
 public:
  CefRefPtr<CefResourceHandler> Create(CefRefPtr<CefBrowser>,
                                       CefRefPtr<CefFrame>, const CefString &,
                                       CefRefPtr<CefRequest>) override {
    return new AIUIResourceHandler();
  }
  IMPLEMENT_REFCOUNTING(AIUISchemeFactory);
};

// MARK: - Browser client

class AIUIClient : public CefClient,
                   public CefLifeSpanHandler,
                   public CefDisplayHandler,
                   public CefContextMenuHandler {
 public:
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefDisplayHandler> GetDisplayHandler() override { return this; }
  CefRefPtr<CefContextMenuHandler> GetContextMenuHandler() override {
    return this;
  }

  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override {
    g_browser = browser;
    NSView *view =
        (__bridge NSView *)browser->GetHost()->GetWindowHandle();
    view.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    view.frame = view.superview.bounds;
    if (g_quit_requested) browser->GetHost()->CloseBrowser(true);
  }

  void OnBeforeClose(CefRefPtr<CefBrowser> browser) override {
    g_browser = nullptr;
    CefQuitMessageLoop();
  }

  bool OnConsoleMessage(CefRefPtr<CefBrowser>, cef_log_severity_t level,
                        const CefString &message, const CefString &source,
                        int line) override {
    NSLog(@"[web] %s (%s:%d)", message.ToString().c_str(),
          source.ToString().c_str(), line);
    return false;
  }

  // No Chromium context menu: right-click belongs to the page.
  void OnBeforeContextMenu(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame>,
                           CefRefPtr<CefContextMenuParams>,
                           CefRefPtr<CefMenuModel> model) override {
    model->Clear();
  }

  IMPLEMENT_REFCOUNTING(AIUIClient);
};

}  // namespace

// MARK: - AIUICef

@implementation AIUICef

+ (BOOL)startWithArgc:(int)argc
                 argv:(char **)argv
                 host:(id<AIUIHost>)host
              webRoot:(NSString *)webRoot
            cachePath:(NSString *)cachePath
              onReady:(void (^)(void))onReady {
  g_loader = new CefScopedLibraryLoader();
  if (!g_loader->LoadInMain()) return NO;

  g_host = host;
  g_web_root = [webRoot copy];

  CefMainArgs main_args(argc, argv);
  CefSettings settings;
  settings.no_sandbox = true;
  settings.background_color = AppearanceBackground();
  CefString(&settings.root_cache_path) = cachePath.UTF8String;
  CefString(&settings.cache_path) =
      [cachePath stringByAppendingPathComponent:@"default"].UTF8String;

  void (^ready)(void) = [onReady copy];
  CefRefPtr<AIUICefApp> app = new AIUICefApp([ready]() {
    CefRegisterSchemeHandlerFactory("aiui", "app", new AIUISchemeFactory());
    ready();
  });
  return CefInitialize(main_args, settings, app.get(), nullptr) ? YES : NO;
}

+ (void)createBrowserInView:(NSView *)view url:(NSString *)url {
  CefWindowInfo info;
  NSRect b = view.bounds;
  info.SetAsChild((__bridge void *)view,
                  CefRect(0, 0, (int)b.size.width, (int)b.size.height));
  CefBrowserSettings bs;
  bs.background_color = AppearanceBackground();
  CefBrowserHost::CreateBrowser(info, new AIUIClient(), url.UTF8String, bs,
                                nullptr, nullptr);
}

+ (void)evalJS:(NSString *)js {
  if (g_browser)
    g_browser->GetMainFrame()->ExecuteJavaScript(js.UTF8String,
                                                 "aiui://app/native", 0);
}

+ (void)showDevTools {
  if (!g_browser) return;
  CefWindowInfo info;
  CefBrowserSettings bs;
  g_browser->GetHost()->ShowDevTools(info, nullptr, bs, CefPoint());
}

+ (void)reload {
  if (g_browser) g_browser->ReloadIgnoreCache();
}

+ (void)requestClose {
  g_quit_requested = true;
  if (g_browser)
    g_browser->GetHost()->CloseBrowser(true);
  else
    CefQuitMessageLoop();
}

+ (void)runMessageLoop {
  CefRunMessageLoop();
}

+ (void)shutdown {
  g_host = nil;
  CefShutdown();
  delete g_loader;
  g_loader = nullptr;
}

@end
