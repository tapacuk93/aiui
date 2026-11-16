// Test stand-in for Sources/Native/AIUICef.mm: the same interface, no CEF. Every call is posted
// as an "AIUICefStub" notification whose object is a description ("js <code>", "browser <url>",
// ...), so tests can assert what the Swift side asked the browser to do. With the environment
// variable AIUI_CEF_STUB_FAIL set, +start fails (and onReady is not called).
#import "AIUICef.h"
#include <stdlib.h>

@implementation AIUIApplication
@end

static void record(NSString *s) {
    [[NSNotificationCenter defaultCenter] postNotificationName:@"AIUICefStub" object:s];
}

@implementation AIUICef

+ (BOOL)startWithArgc:(int)argc argv:(char *_Nullable *_Nonnull)argv host:(id<AIUIHost>)host
              webRoot:(NSString *)webRoot cachePath:(NSString *)cachePath onReady:(void (^)(void))onReady {
    record([NSString stringWithFormat:@"start %@ %@", webRoot, cachePath]);
    if (getenv("AIUI_CEF_STUB_FAIL")) return NO;
    onReady();
    return YES;
}
+ (void)setVendorRoot:(NSString *)path { record([@"vendor " stringByAppendingString:path]); }
+ (void)createBrowserInView:(NSView *)view url:(NSString *)url { record([@"browser " stringByAppendingString:url]); }
+ (void)evalJS:(NSString *)js { record([@"js " stringByAppendingString:js]); }
+ (void)showDevTools { record(@"devtools"); }
+ (void)reload { record(@"reload"); }
+ (void)requestClose { record(@"close"); }
+ (void)runMessageLoop { record(@"loop"); }
+ (void)shutdown { record(@"shutdown"); }

@end
