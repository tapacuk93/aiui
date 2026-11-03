// Entry point for the "aiui Helper*.app" subprocesses (renderer, GPU, ...).
#include "include/cef_app.h"
#include "include/wrapper/cef_library_loader.h"

#include "AIUICefApp.h"

int main(int argc, char* argv[]) {
  CefScopedLibraryLoader library_loader;
  if (!library_loader.LoadInHelper()) return 1;
  CefMainArgs main_args(argc, argv);
  CefRefPtr<CefApp> app = new AIUICefApp();
  return CefExecuteProcess(main_args, app, nullptr);
}
