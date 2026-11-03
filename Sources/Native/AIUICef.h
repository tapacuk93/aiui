// Objective-C face of the CEF (Blink) embedding, visible to Swift.
#import <Cocoa/Cocoa.h>

NS_ASSUME_NONNULL_BEGIN

/// NSApplication subclass CEF requires on macOS (implements CefAppProtocol).
@interface AIUIApplication : NSApplication
@end

/// Reply for an aiui://app/api/... request: HTTP status, MIME type, body.
typedef void (^AIUIReply)(NSInteger status, NSString *mime, NSData *body);

/// Native side of the page's fetch('/api/...') calls.
@protocol AIUIHost <NSObject>
- (void)handleAPI:(NSString *)path body:(NSData *)body reply:(AIUIReply)reply;
@end

@interface AIUICef : NSObject

/// Loads the CEF framework and initializes it. `webRoot` is served at aiui://app/.
/// `onReady` runs on the main thread once the browser context is up.
+ (BOOL)startWithArgc:(int)argc
                 argv:(char *_Nullable *_Nonnull)argv
                 host:(id<AIUIHost>)host
              webRoot:(NSString *)webRoot
            cachePath:(NSString *)cachePath
              onReady:(void (^)(void))onReady;

/// Folder served at aiui://app/vendor/ (installed JS libraries).
+ (void)setVendorRoot:(NSString *)path;

/// Creates the Blink browser filling `view` (resizes with it).
+ (void)createBrowserInView:(NSView *)view url:(NSString *)url;

/// Runs JavaScript in the main frame.
+ (void)evalJS:(NSString *)js;

+ (void)showDevTools;
+ (void)reload;

/// Closes the browser; the message loop quits once it is gone.
+ (void)requestClose;

+ (void)runMessageLoop;
+ (void)shutdown;

@end

NS_ASSUME_NONNULL_END
