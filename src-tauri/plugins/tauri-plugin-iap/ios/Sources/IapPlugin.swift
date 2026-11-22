import StoreKit
import SwiftRs
import Tauri
import UIKit
import WebKit

class ProductsArgs: Decodable {
  let ids: [String]
}

class PurchaseArgs: Decodable {
  let productId: String
  let accountToken: String
}

/// In-App-Kauf mit StoreKit 2. Apple signiert jede Transaktion; die App reicht den Beleg unverändert an den
/// Grid-Server, der die Signatur prüft. Die Kontokennung (UUID) steht als `appAccountToken` im Beleg.
class IapPlugin: Plugin {
  private static func period(_ p: Product.SubscriptionPeriod) -> String {
    switch p.unit {
    case .day: return "P\(p.value)D"
    case .week: return "P\(p.value)W"
    case .month: return "P\(p.value)M"
    case .year: return "P\(p.value)Y"
    @unknown default: return ""
    }
  }

  @objc public func products(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ProductsArgs.self)
    Task {
      do {
        let items = try await Product.products(for: args.ids)
        let list: [[String: String]] = items.map { p in
          [
            "id": p.id,
            "name": p.displayName,
            "description": p.description,
            "price": p.displayPrice,
            "period": p.subscription.map { IapPlugin.period($0.subscriptionPeriod) } ?? "",
          ]
        }
        invoke.resolve(["products": list])
      } catch {
        invoke.reject(error.localizedDescription)
      }
    }
  }

  @objc public func purchase(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(PurchaseArgs.self)
    guard let token = UUID(uuidString: args.accountToken) else {
      invoke.reject("Die Kontokennung ist keine gültige UUID")
      return
    }
    Task {
      do {
        guard let product = try await Product.products(for: [args.productId]).first else {
          invoke.reject("Das Produkt gibt es im App Store nicht (oder noch nicht)")
          return
        }
        let result = try await product.purchase(options: [.appAccountToken(token)])
        switch result {
        case .success(let verification):
          switch verification {
          case .verified(let transaction):
            await transaction.finish()
            invoke.resolve(["status": "success", "jws": verification.jwsRepresentation])
          case .unverified(_, let error):
            invoke.reject("Der Kauf konnte nicht geprüft werden: \(error.localizedDescription)")
          }
        case .pending:
          invoke.resolve(["status": "pending"])
        case .userCancelled:
          invoke.resolve(["status": "cancelled"])
        @unknown default:
          invoke.reject("Unbekanntes Ergebnis des Kaufs")
        }
      } catch {
        invoke.reject(error.localizedDescription)
      }
    }
  }

  /// Alle gerade gültigen Käufe dieses Apple-Kontos (auch die, die auf einem anderen Gerät gemacht wurden).
  private func entitlements() async -> [String] {
    var list: [String] = []
    for await result in Transaction.currentEntitlements {
      if case .verified = result { list.append(result.jwsRepresentation) }
    }
    return list
  }

  @objc public func current(_ invoke: Invoke) throws {
    Task { invoke.resolve(["transactions": await entitlements()]) }
  }

  /// „Käufe wiederherstellen“: gleicht mit dem App Store ab (kann nach einer Anmeldung nachfragen) und liefert danach alle Käufe.
  @objc public func restore(_ invoke: Invoke) throws {
    Task {
      do {
        try await AppStore.sync()
        invoke.resolve(["transactions": await entitlements()])
      } catch {
        invoke.reject(error.localizedDescription)
      }
    }
  }
}

@_cdecl("init_plugin_iap")
public func initPlugin() -> Plugin {
  return IapPlugin()
}
