// Shared CefApp used by the main process and every helper process.
// Registers the aiui:// scheme (must happen identically in all processes).
#pragma once

#include <cstdlib>
#include <functional>

#include "include/cef_app.h"

class AIUICefApp : public CefApp, public CefBrowserProcessHandler {
 public:
  explicit AIUICefApp(std::function<void()> on_ready = nullptr)
      : on_ready_(std::move(on_ready)) {}

  void OnRegisterCustomSchemes(
      CefRawPtr<CefSchemeRegistrar> registrar) override {
    registrar->AddCustomScheme(
        "aiui", CEF_SCHEME_OPTION_STANDARD | CEF_SCHEME_OPTION_SECURE |
                    CEF_SCHEME_OPTION_CORS_ENABLED |
                    CEF_SCHEME_OPTION_FETCH_ENABLED);
  }

  void OnBeforeCommandLineProcessing(
      const CefString& process_type,
      CefRefPtr<CefCommandLine> command_line) override {
    if (process_type.empty()) {
      // Keep the login keychain out of it; aiui stores no web credentials.
      command_line->AppendSwitch("use-mock-keychain");
      // AIUI_DEBUG_PORT=9333 exposes Chrome DevTools Protocol for scripting/tests.
      if (const char* port = getenv("AIUI_DEBUG_PORT")) {
        command_line->AppendSwitchWithValue("remote-debugging-port", port);
        command_line->AppendSwitchWithValue("remote-allow-origins", "*");
      }
    }
  }

  CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override {
    return this;
  }

  void OnContextInitialized() override {
    if (on_ready_) on_ready_();
  }

 private:
  std::function<void()> on_ready_;
  IMPLEMENT_REFCOUNTING(AIUICefApp);
};
