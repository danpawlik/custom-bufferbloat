# OpenWrt package for self-hosted bufferbloat test.
#
# Use as a feed:
#   cp feeds.conf.default feeds.conf
#   echo 'src-git my https://github.com/danpawlik/custom-bufferbloat.git' >> feeds.conf
#   ./scripts/feeds update my && ./scripts/feeds install -a
#   make package/feeds/my/openwrt/compile V=s
#
# Builds the Go binary with the OpenWrt golang/host toolchain (from the
# packages feed), so no Go is needed on the build host and the result
# matches the target architecture.

include $(TOPDIR)/rules.mk

PKG_NAME:=bufferbloat-test
PKG_VERSION:=0.1.0
PKG_RELEASE:=3

PKG_MAINTAINER:=OpenWrt Builder <noreply@local>
PKG_LICENSE:=MIT

PKG_BUILD_DEPENDS:=golang/host
PKG_BUILD_PARALLEL:=1

# The Go module lives at the repository root; this Makefile is in openwrt/.
GO_PKG:=github.com/openwrt-builder/custom-bufferbloat
GO_PKG_BUILD_PKG:=$(GO_PKG)/cmd/server
# Web assets are embedded, so they must be copied into the Go build tree too.
GO_PKG_INSTALL_ALL:=1

include $(INCLUDE_DIR)/package.mk
include $(TOPDIR)/feeds/packages/lang/golang/golang-package.mk

define Package/bufferbloat-test
  SECTION:=net
  CATEGORY:=Network
  TITLE:=Self-hosted bufferbloat web test
  URL:=https://github.com/openwrt-builder/custom-bufferbloat
  DEPENDS:=
endef

define Package/bufferbloat-test/description
  HTTP bufferbloat test (LibreQoS-style) for VPS and OpenWrt.
  Serves a browser UI plus /ping /download /upload endpoints.
endef

define Package/bufferbloat-test/conffiles
/etc/config/bufferbloat-test
endef

# PKG_BUILD_DIR is this openwrt/ subdirectory's copy; the Go sources are one level up.
define Build/Prepare
	$(INSTALL_DIR) $(PKG_BUILD_DIR)
	$(CP) $(CURDIR)/../go.mod $(PKG_BUILD_DIR)/
	$(CP) $(CURDIR)/../cmd $(CURDIR)/../internal $(CURDIR)/../web $(PKG_BUILD_DIR)/
endef

# 'go install' names the binary after its directory (server), so rename it here.
define Package/bufferbloat-test/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(GO_PKG_BUILD_BIN_DIR)/server $(1)/usr/bin/bufferbloat-test
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/etc/config/bufferbloat-test $(1)/etc/config/bufferbloat-test
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/etc/init.d/bufferbloat-test $(1)/etc/init.d/bufferbloat-test
endef

$(eval $(call BuildPackage,bufferbloat-test))
