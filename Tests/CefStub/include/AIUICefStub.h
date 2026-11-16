// Test-only controls of the CEF stub (Tests/CefStub/AIUICefStub.m).
#import <Foundation/Foundation.h>
NS_ASSUME_NONNULL_BEGIN
/// Every call the Swift side made into AIUICef, in order ("js <code>", "browser <url>", ...).
NSMutableArray<NSString *> *AIUICefStubCalls(void);
/// What +startWithArgc:... returns (and whether it calls onReady).
void AIUICefStubSetStartResult(BOOL ok);
NS_ASSUME_NONNULL_END
