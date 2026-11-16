// Test stand-in for Sources/Native/AIUICef.mm: the same interface, no CEF. Every call is
// recorded (AIUICefStubCalls) so tests can assert what the Swift side asked the browser to do.
#import "AIUICef.h"

@implementation AIUIApplication
@end

static NSMutableArray<NSString *> *calls;
static BOOL startResult = YES;

NSMutableArray<NSString *> *AIUICefStubCalls(void) {
    if (!calls) calls = [NSMutableArray array];
    return calls;
}

void AIUICefStubSetStartResult(BOOL ok) { startResult = ok; }

static void record(NSString *s) { [AIUICefStubCalls() addObject:s]; }

@implementation AIUICef

+ (BOOL)startWithArgc:(int)argc argv:(char *_Nullable *_Nonnull)argv host:(id<AIUIHost>)host
              webRoot:(NSString *)webRoot cachePath:(NSString *)cachePath onReady:(void (^)(void))onReady {
    record([NSString stringWithFormat:@"start %@ %@", webRoot, cachePath]);
    if (startResult) onReady();
    return startResult;
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
